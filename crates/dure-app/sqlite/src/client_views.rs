use std::time::{SystemTime, UNIX_EPOCH};

use dure_app::{
    CLIENT_VIEW_STATE_SCHEMA_VERSION_V1, ClientIdV1, ClientInstanceIdV1, ClientViewAuthorityV1,
    ClientViewGenerationAdvanceRequestV1, ClientViewGenerationReceiptV1, ClientViewIdV1,
    ClientViewIdentityV1, ClientViewNamespaceV1, ClientViewPresentationV1, ClientViewRecordV1,
    ClientViewWriteReceiptV1, ClientViewWriteRequestV1, DomainStoreErrorV1,
    MAX_CLIENT_VIEWS_PER_CLIENT_V1, TenantIdV1, UserIdV1,
};
use sqlx::{Row, SqliteConnection, SqlitePool};

use crate::error::{corrupt_identifier, corrupt_row, map_sqlx, serialization, storage};
use crate::schema::{begin_immediate, finish_transaction};

pub(crate) async fn authority(
    pool: &SqlitePool,
    namespace: &ClientViewNamespaceV1,
) -> Result<Option<ClientViewAuthorityV1>, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("read_client_view_authority", error))?;
    authority_on(&mut connection, namespace).await
}

pub(crate) async fn advance_generation(
    pool: &SqlitePool,
    request: &ClientViewGenerationAdvanceRequestV1,
) -> Result<ClientViewGenerationReceiptV1, DomainStoreErrorV1> {
    request.validate()?;
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("advance_client_view_generation", error))?;
    begin_immediate(&mut connection, "advance_client_view_generation").await?;

    let result = async {
        if let Some(receipt) = generation_receipt_for_request(&mut connection, request).await? {
            return Ok(receipt);
        }

        let current = authority_on(&mut connection, &request.namespace).await?;
        let actual_generation = current
            .as_ref()
            .map(|authority| authority.client_generation);
        if actual_generation.unwrap_or(0) != request.expected_generation {
            return Err(DomainStoreErrorV1::ClientViewGenerationConflict {
                client_id: request.namespace.client_id.to_string(),
                expected_generation: request.expected_generation,
                actual_generation,
            });
        }
        if let Some(current) = &current {
            if request.expected_instance_id.as_ref() != Some(&current.client_instance_id) {
                return Err(DomainStoreErrorV1::ClientViewInstanceConflict {
                    client_id: request.namespace.client_id.to_string(),
                    client_generation: current.client_generation,
                });
            }
        }

        let client_generation = request
            .expected_generation
            .checked_add(1)
            .ok_or_else(|| storage("generation_exhausted", "Client view generation overflow"))?;
        let now = now_ms()?;
        let updated_at_ms = current
            .as_ref()
            .map_or(now, |authority| now.max(authority.updated_at_ms));
        let authority = ClientViewAuthorityV1 {
            schema_version: CLIENT_VIEW_STATE_SCHEMA_VERSION_V1,
            namespace: request.namespace.clone(),
            client_generation,
            client_instance_id: request.next_instance_id.clone(),
            updated_at_ms,
        };
        authority.validate()?;

        sqlx::query(
            r#"
            INSERT INTO client_view_authorities (
                tenant_id,
                user_id,
                client_id,
                schema_version,
                client_generation,
                client_instance_id,
                updated_at_ms
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(tenant_id, user_id, client_id) DO UPDATE SET
                schema_version = excluded.schema_version,
                client_generation = excluded.client_generation,
                client_instance_id = excluded.client_instance_id,
                updated_at_ms = excluded.updated_at_ms
            "#,
        )
        .bind(request.namespace.tenant_id.as_str())
        .bind(request.namespace.user_id.as_str())
        .bind(request.namespace.client_id.as_str())
        .bind(i64::from(authority.schema_version))
        .bind(authority.client_generation)
        .bind(authority.client_instance_id.as_str())
        .bind(authority.updated_at_ms)
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx("advance_client_view_generation", error))?;

        sqlx::query(
            r#"
            DELETE FROM client_views
            WHERE tenant_id = ?1 AND user_id = ?2 AND client_id = ?3
            "#,
        )
        .bind(request.namespace.tenant_id.as_str())
        .bind(request.namespace.user_id.as_str())
        .bind(request.namespace.client_id.as_str())
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx("retire_client_views", error))?;

        sqlx::query(
            r#"
            INSERT INTO client_view_generation_receipts (
                idempotency_key,
                schema_version,
                tenant_id,
                user_id,
                client_id,
                expected_generation,
                expected_instance_id,
                next_instance_id,
                result_generation,
                result_updated_at_ms
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            "#,
        )
        .bind(&request.idempotency_key)
        .bind(i64::from(request.schema_version))
        .bind(request.namespace.tenant_id.as_str())
        .bind(request.namespace.user_id.as_str())
        .bind(request.namespace.client_id.as_str())
        .bind(request.expected_generation)
        .bind(
            request
                .expected_instance_id
                .as_ref()
                .map(ClientInstanceIdV1::as_str),
        )
        .bind(request.next_instance_id.as_str())
        .bind(authority.client_generation)
        .bind(authority.updated_at_ms)
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx("write_client_view_generation_receipt", error))?;

        Ok(ClientViewGenerationReceiptV1 {
            schema_version: CLIENT_VIEW_STATE_SCHEMA_VERSION_V1,
            idempotency_key: request.idempotency_key.clone(),
            authority,
        })
    }
    .await;

    finish_transaction(&mut connection, "advance_client_view_generation", result).await
}

pub(crate) async fn view(
    pool: &SqlitePool,
    identity: &ClientViewIdentityV1,
) -> Result<Option<ClientViewRecordV1>, DomainStoreErrorV1> {
    identity.validate()?;
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("read_client_view", error))?;
    sqlx::query("BEGIN")
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx("read_client_view", error))?;

    let result = async {
        validate_exact_authority(&mut connection, identity).await?;
        view_on(&mut connection, identity).await
    }
    .await;

    finish_transaction(&mut connection, "read_client_view", result).await
}

pub(crate) async fn write_view(
    pool: &SqlitePool,
    request: &ClientViewWriteRequestV1,
) -> Result<ClientViewWriteReceiptV1, DomainStoreErrorV1> {
    request.validate()?;
    let presentation_json = serde_json::to_string(&request.presentation)
        .map_err(|error| serialization("client view presentation", error))?;
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("write_client_view", error))?;
    begin_immediate(&mut connection, "write_client_view").await?;

    let result = async {
        if let Some(receipt) = write_receipt_for_request(&mut connection, request).await? {
            return Ok(receipt);
        }

        validate_exact_authority(&mut connection, &request.identity).await?;
        let current = view_on(&mut connection, &request.identity).await?;
        let actual_revision = current.as_ref().map(|record| record.revision);
        if actual_revision.unwrap_or(0) != request.expected_revision {
            return Err(DomainStoreErrorV1::ClientViewRevisionConflict {
                client_id: request.identity.namespace.client_id.to_string(),
                view_id: request.identity.view_id.to_string(),
                expected_revision: request.expected_revision,
                actual_revision,
            });
        }
        if current.is_none() {
            let view_count: i64 = sqlx::query_scalar(
                r#"
                SELECT COUNT(*)
                FROM client_views
                WHERE tenant_id = ?1 AND user_id = ?2 AND client_id = ?3
                "#,
            )
            .bind(request.identity.namespace.tenant_id.as_str())
            .bind(request.identity.namespace.user_id.as_str())
            .bind(request.identity.namespace.client_id.as_str())
            .fetch_one(&mut *connection)
            .await
            .map_err(|error| map_sqlx("count_client_views", error))?;
            let view_count = usize::try_from(view_count)
                .map_err(|error| storage("corrupt_client_view_count", error.to_string()))?;
            if view_count >= MAX_CLIENT_VIEWS_PER_CLIENT_V1 {
                return Err(DomainStoreErrorV1::InvalidRecord {
                    field: "viewId",
                    reason: "client view count exceeds the bounded limit".into(),
                });
            }
        }
        let revision = request
            .expected_revision
            .checked_add(1)
            .ok_or_else(|| storage("revision_exhausted", "Client view revision overflow"))?;
        let now = now_ms()?;
        let updated_at_ms = current
            .as_ref()
            .map_or(now, |record| now.max(record.updated_at_ms));
        let record = ClientViewRecordV1 {
            schema_version: CLIENT_VIEW_STATE_SCHEMA_VERSION_V1,
            identity: request.identity.clone(),
            revision,
            presentation: request.presentation.clone(),
            updated_at_ms,
        };
        record.validate()?;

        sqlx::query(
            r#"
            INSERT INTO client_views (
                tenant_id,
                user_id,
                client_id,
                view_id,
                schema_version,
                client_generation,
                client_instance_id,
                revision,
                presentation_json,
                updated_at_ms
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            ON CONFLICT(tenant_id, user_id, client_id, view_id) DO UPDATE SET
                schema_version = excluded.schema_version,
                client_generation = excluded.client_generation,
                client_instance_id = excluded.client_instance_id,
                revision = excluded.revision,
                presentation_json = excluded.presentation_json,
                updated_at_ms = excluded.updated_at_ms
            "#,
        )
        .bind(request.identity.namespace.tenant_id.as_str())
        .bind(request.identity.namespace.user_id.as_str())
        .bind(request.identity.namespace.client_id.as_str())
        .bind(request.identity.view_id.as_str())
        .bind(i64::from(record.schema_version))
        .bind(request.identity.client_generation)
        .bind(request.identity.client_instance_id.as_str())
        .bind(record.revision)
        .bind(&presentation_json)
        .bind(record.updated_at_ms)
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx("write_client_view", error))?;

        sqlx::query(
            r#"
            INSERT INTO client_view_write_receipts (
                idempotency_key,
                schema_version,
                tenant_id,
                user_id,
                client_id,
                client_generation,
                client_instance_id,
                view_id,
                expected_revision,
                presentation_json,
                result_revision,
                result_updated_at_ms
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
            "#,
        )
        .bind(&request.idempotency_key)
        .bind(i64::from(request.schema_version))
        .bind(request.identity.namespace.tenant_id.as_str())
        .bind(request.identity.namespace.user_id.as_str())
        .bind(request.identity.namespace.client_id.as_str())
        .bind(request.identity.client_generation)
        .bind(request.identity.client_instance_id.as_str())
        .bind(request.identity.view_id.as_str())
        .bind(request.expected_revision)
        .bind(&presentation_json)
        .bind(record.revision)
        .bind(record.updated_at_ms)
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx("write_client_view_receipt", error))?;

        Ok(ClientViewWriteReceiptV1 {
            schema_version: CLIENT_VIEW_STATE_SCHEMA_VERSION_V1,
            idempotency_key: request.idempotency_key.clone(),
            record,
        })
    }
    .await;

    finish_transaction(&mut connection, "write_client_view", result).await
}

async fn validate_exact_authority(
    connection: &mut SqliteConnection,
    identity: &ClientViewIdentityV1,
) -> Result<ClientViewAuthorityV1, DomainStoreErrorV1> {
    let Some(authority) = authority_on(connection, &identity.namespace).await? else {
        return Err(DomainStoreErrorV1::ClientViewGenerationConflict {
            client_id: identity.namespace.client_id.to_string(),
            expected_generation: identity.client_generation,
            actual_generation: None,
        });
    };
    if authority.client_generation != identity.client_generation {
        return Err(DomainStoreErrorV1::ClientViewGenerationConflict {
            client_id: identity.namespace.client_id.to_string(),
            expected_generation: identity.client_generation,
            actual_generation: Some(authority.client_generation),
        });
    }
    if authority.client_instance_id != identity.client_instance_id {
        return Err(DomainStoreErrorV1::ClientViewInstanceConflict {
            client_id: identity.namespace.client_id.to_string(),
            client_generation: identity.client_generation,
        });
    }
    Ok(authority)
}

async fn authority_on(
    connection: &mut SqliteConnection,
    namespace: &ClientViewNamespaceV1,
) -> Result<Option<ClientViewAuthorityV1>, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT
            tenant_id,
            user_id,
            client_id,
            schema_version,
            client_generation,
            client_instance_id,
            updated_at_ms
        FROM client_view_authorities
        WHERE tenant_id = ?1 AND user_id = ?2 AND client_id = ?3
        "#,
    )
    .bind(namespace.tenant_id.as_str())
    .bind(namespace.user_id.as_str())
    .bind(namespace.client_id.as_str())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_client_view_authority", error))?;
    row.map(authority_from_row).transpose()
}

async fn view_on(
    connection: &mut SqliteConnection,
    identity: &ClientViewIdentityV1,
) -> Result<Option<ClientViewRecordV1>, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT
            tenant_id,
            user_id,
            client_id,
            view_id,
            schema_version,
            client_generation,
            client_instance_id,
            revision,
            presentation_json,
            updated_at_ms
        FROM client_views
        WHERE tenant_id = ?1 AND user_id = ?2 AND client_id = ?3 AND view_id = ?4
        "#,
    )
    .bind(identity.namespace.tenant_id.as_str())
    .bind(identity.namespace.user_id.as_str())
    .bind(identity.namespace.client_id.as_str())
    .bind(identity.view_id.as_str())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_client_view", error))?;
    let record = row.map(view_from_row).transpose()?;
    if record
        .as_ref()
        .is_some_and(|record| record.identity != *identity)
    {
        return Err(storage(
            "corrupt_client_view",
            "Stored client view identity does not match its active authority",
        ));
    }
    Ok(record)
}

async fn generation_receipt_for_request(
    connection: &mut SqliteConnection,
    request: &ClientViewGenerationAdvanceRequestV1,
) -> Result<Option<ClientViewGenerationReceiptV1>, DomainStoreErrorV1> {
    let Some(row) = sqlx::query(
        r#"
        SELECT
            idempotency_key,
            schema_version,
            tenant_id,
            user_id,
            client_id,
            expected_generation,
            expected_instance_id,
            next_instance_id,
            result_generation,
            result_updated_at_ms
        FROM client_view_generation_receipts
        WHERE idempotency_key = ?1
        "#,
    )
    .bind(&request.idempotency_key)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_client_view_generation_receipt", error))?
    else {
        return Ok(None);
    };

    let schema_version = stored_schema_version(&row, "client_view_generation_receipts")?;
    let namespace = namespace_from_row(&row, "client_view_generation_receipts")?;
    let expected_generation: i64 = row
        .try_get("expected_generation")
        .map_err(|error| corrupt_row("client_view_generation_receipts", error))?;
    let expected_instance_id = optional_instance_id_from_row(
        &row,
        "expected_instance_id",
        "client_view_generation_receipts",
    )?;
    let next_instance_id =
        instance_id_from_row(&row, "next_instance_id", "client_view_generation_receipts")?;
    let receipt = ClientViewGenerationReceiptV1 {
        schema_version,
        idempotency_key: request.idempotency_key.clone(),
        authority: ClientViewAuthorityV1 {
            schema_version,
            namespace: namespace.clone(),
            client_generation: row
                .try_get("result_generation")
                .map_err(|error| corrupt_row("client_view_generation_receipts", error))?,
            client_instance_id: next_instance_id.clone(),
            updated_at_ms: row
                .try_get("result_updated_at_ms")
                .map_err(|error| corrupt_row("client_view_generation_receipts", error))?,
        },
    };
    receipt
        .validate()
        .map_err(|error| storage("corrupt_client_view_generation_receipt", error.to_string()))?;
    if schema_version != request.schema_version
        || namespace != request.namespace
        || expected_generation != request.expected_generation
        || expected_instance_id != request.expected_instance_id
        || next_instance_id != request.next_instance_id
    {
        return Err(DomainStoreErrorV1::IdempotencyConflict {
            reason: "Client view generation idempotency key belongs to a different request".into(),
        });
    }
    Ok(Some(receipt))
}

async fn write_receipt_for_request(
    connection: &mut SqliteConnection,
    request: &ClientViewWriteRequestV1,
) -> Result<Option<ClientViewWriteReceiptV1>, DomainStoreErrorV1> {
    let Some(row) = sqlx::query(
        r#"
        SELECT
            idempotency_key,
            schema_version,
            tenant_id,
            user_id,
            client_id,
            client_generation,
            client_instance_id,
            view_id,
            expected_revision,
            presentation_json,
            result_revision,
            result_updated_at_ms
        FROM client_view_write_receipts
        WHERE idempotency_key = ?1
        "#,
    )
    .bind(&request.idempotency_key)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_client_view_write_receipt", error))?
    else {
        return Ok(None);
    };

    let schema_version = stored_schema_version(&row, "client_view_write_receipts")?;
    let presentation = presentation_from_row(&row, "client_view_write_receipts")?;
    let identity = ClientViewIdentityV1 {
        namespace: namespace_from_row(&row, "client_view_write_receipts")?,
        client_generation: row
            .try_get("client_generation")
            .map_err(|error| corrupt_row("client_view_write_receipts", error))?,
        client_instance_id: instance_id_from_row(
            &row,
            "client_instance_id",
            "client_view_write_receipts",
        )?,
        view_id: view_id_from_row(&row, "client_view_write_receipts")?,
    };
    let expected_revision: i64 = row
        .try_get("expected_revision")
        .map_err(|error| corrupt_row("client_view_write_receipts", error))?;
    let receipt = ClientViewWriteReceiptV1 {
        schema_version,
        idempotency_key: request.idempotency_key.clone(),
        record: ClientViewRecordV1 {
            schema_version,
            identity: identity.clone(),
            revision: row
                .try_get("result_revision")
                .map_err(|error| corrupt_row("client_view_write_receipts", error))?,
            presentation: presentation.clone(),
            updated_at_ms: row
                .try_get("result_updated_at_ms")
                .map_err(|error| corrupt_row("client_view_write_receipts", error))?,
        },
    };
    receipt
        .validate()
        .map_err(|error| storage("corrupt_client_view_write_receipt", error.to_string()))?;
    if schema_version != request.schema_version
        || identity != request.identity
        || expected_revision != request.expected_revision
        || presentation != request.presentation
    {
        return Err(DomainStoreErrorV1::IdempotencyConflict {
            reason: "Client view write idempotency key belongs to a different request".into(),
        });
    }
    Ok(Some(receipt))
}

fn authority_from_row(
    row: sqlx::sqlite::SqliteRow,
) -> Result<ClientViewAuthorityV1, DomainStoreErrorV1> {
    let authority = ClientViewAuthorityV1 {
        schema_version: stored_schema_version(&row, "client_view_authorities")?,
        namespace: namespace_from_row(&row, "client_view_authorities")?,
        client_generation: row
            .try_get("client_generation")
            .map_err(|error| corrupt_row("client_view_authorities", error))?,
        client_instance_id: instance_id_from_row(
            &row,
            "client_instance_id",
            "client_view_authorities",
        )?,
        updated_at_ms: row
            .try_get("updated_at_ms")
            .map_err(|error| corrupt_row("client_view_authorities", error))?,
    };
    authority
        .validate()
        .map_err(|error| storage("corrupt_client_view_authority", error.to_string()))?;
    Ok(authority)
}

fn view_from_row(row: sqlx::sqlite::SqliteRow) -> Result<ClientViewRecordV1, DomainStoreErrorV1> {
    let record = ClientViewRecordV1 {
        schema_version: stored_schema_version(&row, "client_views")?,
        identity: ClientViewIdentityV1 {
            namespace: namespace_from_row(&row, "client_views")?,
            client_generation: row
                .try_get("client_generation")
                .map_err(|error| corrupt_row("client_views", error))?,
            client_instance_id: instance_id_from_row(&row, "client_instance_id", "client_views")?,
            view_id: view_id_from_row(&row, "client_views")?,
        },
        revision: row
            .try_get("revision")
            .map_err(|error| corrupt_row("client_views", error))?,
        presentation: presentation_from_row(&row, "client_views")?,
        updated_at_ms: row
            .try_get("updated_at_ms")
            .map_err(|error| corrupt_row("client_views", error))?,
    };
    record
        .validate()
        .map_err(|error| storage("corrupt_client_view", error.to_string()))?;
    Ok(record)
}

fn namespace_from_row(
    row: &sqlx::sqlite::SqliteRow,
    table: &'static str,
) -> Result<ClientViewNamespaceV1, DomainStoreErrorV1> {
    let tenant_id: String = row
        .try_get("tenant_id")
        .map_err(|error| corrupt_row(table, error))?;
    let user_id: String = row
        .try_get("user_id")
        .map_err(|error| corrupt_row(table, error))?;
    let client_id: String = row
        .try_get("client_id")
        .map_err(|error| corrupt_row(table, error))?;
    Ok(ClientViewNamespaceV1 {
        tenant_id: TenantIdV1::new(tenant_id)
            .map_err(|error| corrupt_identifier("client_view.tenant_id", error))?,
        user_id: UserIdV1::new(user_id)
            .map_err(|error| corrupt_identifier("client_view.user_id", error))?,
        client_id: ClientIdV1::new(client_id)
            .map_err(|error| corrupt_identifier("client_view.client_id", error))?,
    })
}

fn instance_id_from_row(
    row: &sqlx::sqlite::SqliteRow,
    column: &'static str,
    table: &'static str,
) -> Result<ClientInstanceIdV1, DomainStoreErrorV1> {
    let value: String = row
        .try_get(column)
        .map_err(|error| corrupt_row(table, error))?;
    ClientInstanceIdV1::new(value)
        .map_err(|error| corrupt_identifier("client_view.client_instance_id", error))
}

fn optional_instance_id_from_row(
    row: &sqlx::sqlite::SqliteRow,
    column: &'static str,
    table: &'static str,
) -> Result<Option<ClientInstanceIdV1>, DomainStoreErrorV1> {
    let value: Option<String> = row
        .try_get(column)
        .map_err(|error| corrupt_row(table, error))?;
    value
        .map(ClientInstanceIdV1::new)
        .transpose()
        .map_err(|error| corrupt_identifier("client_view.expected_instance_id", error))
}

fn view_id_from_row(
    row: &sqlx::sqlite::SqliteRow,
    table: &'static str,
) -> Result<ClientViewIdV1, DomainStoreErrorV1> {
    let value: String = row
        .try_get("view_id")
        .map_err(|error| corrupt_row(table, error))?;
    ClientViewIdV1::new(value).map_err(|error| corrupt_identifier("client_view.view_id", error))
}

fn presentation_from_row(
    row: &sqlx::sqlite::SqliteRow,
    table: &'static str,
) -> Result<ClientViewPresentationV1, DomainStoreErrorV1> {
    let value: String = row
        .try_get("presentation_json")
        .map_err(|error| corrupt_row(table, error))?;
    serde_json::from_str(&value).map_err(|error| serialization("client view presentation", error))
}

fn stored_schema_version(
    row: &sqlx::sqlite::SqliteRow,
    table: &'static str,
) -> Result<u16, DomainStoreErrorV1> {
    let value: i64 = row
        .try_get("schema_version")
        .map_err(|error| corrupt_row(table, error))?;
    u16::try_from(value).map_err(|error| storage("corrupt_schema_version", error.to_string()))
}

fn now_ms() -> Result<i64, DomainStoreErrorV1> {
    let milliseconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| storage("system_clock", error.to_string()))?
        .as_millis();
    i64::try_from(milliseconds).map_err(|error| storage("system_clock", error.to_string()))
}
