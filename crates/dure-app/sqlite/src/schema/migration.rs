use super::*;
use sqlx::Connection;

#[cfg(test)]
mod tests;

struct SchemaChange<'a> {
    statements: &'a [&'a str],
    rebuild_referenced_tables: bool,
}

pub(super) async fn migrate_schema(
    pool: &SqlitePool,
    path: &Path,
    existing_marker: Option<MigrationMarker>,
    from_version: u32,
    to_version: u32,
    statements: &[&str],
    operation: &'static str,
) -> Result<(), DomainStoreErrorV1> {
    migrate_change(
        pool,
        path,
        existing_marker,
        from_version,
        to_version,
        SchemaChange {
            statements,
            rebuild_referenced_tables: false,
        },
        operation,
    )
    .await
}

pub(super) async fn migrate_checkout_binding_schema(
    pool: &SqlitePool,
    path: &Path,
    existing_marker: Option<MigrationMarker>,
) -> Result<(), DomainStoreErrorV1> {
    migrate_schema(
        pool,
        path,
        existing_marker,
        41,
        42,
        &[crate::session_checkout::CREATE_BINDINGS],
        "migrate_v41_to_v42",
    )
    .await
}

pub(super) async fn migrate_browser_profile_schema(
    pool: &SqlitePool,
    path: &Path,
    existing_marker: Option<MigrationMarker>,
) -> Result<(), DomainStoreErrorV1> {
    migrate_schema(
        pool,
        path,
        existing_marker,
        42,
        43,
        &[
            crate::browser_profiles::CREATE_PROFILES,
            crate::browser_profiles::CREATE_DEFAULT,
        ],
        "migrate_v42_to_v43",
    )
    .await
}

pub(super) async fn migrate_agent_checkout_schema(
    pool: &SqlitePool,
    path: &Path,
    existing_marker: Option<MigrationMarker>,
) -> Result<(), DomainStoreErrorV1> {
    let mut statements = Vec::new();
    if !table_column_exists(pool, "agents", "checkout_owner_id").await? {
        statements.push(crate::agent_runtime_checkout::ADD_AGENT_CHECKOUT_OWNER);
    }
    if table_column_exists(pool, "agent_runtime_selections", "checkout_owner_id").await? {
        statements.extend([
            "UPDATE agents SET checkout_owner_id = (SELECT checkout_owner_id \
             FROM agent_runtime_selections WHERE agent_runtime_selections.agent_id = agents.agent_id) \
             WHERE agent_id IN (SELECT agent_id FROM agent_runtime_selections WHERE checkout_owner_id IS NOT NULL)",
            "ALTER TABLE agent_runtime_selections DROP COLUMN checkout_owner_id",
        ]);
    }
    migrate_schema(
        pool,
        path,
        existing_marker,
        45,
        46,
        &statements,
        "migrate_v45_to_v46",
    )
    .await
}

pub(super) async fn migrate_graph_schema(
    pool: &SqlitePool,
    path: &Path,
    existing_marker: Option<MigrationMarker>,
) -> Result<(), DomainStoreErrorV1> {
    migrate_change(
        pool,
        path,
        existing_marker,
        40,
        41,
        SchemaChange {
            statements: crate::workflow_graph::execution_schema::MIGRATION,
            rebuild_referenced_tables: true,
        },
        "migrate_v40_to_v41",
    )
    .await
}

async fn migrate_change(
    pool: &SqlitePool,
    path: &Path,
    existing_marker: Option<MigrationMarker>,
    from_version: u32,
    to_version: u32,
    change: SchemaChange<'_>,
    operation: &'static str,
) -> Result<(), DomainStoreErrorV1> {
    let marker = match existing_marker {
        Some(marker) => marker,
        None => {
            let backup_path = create_migration_backup(pool, path, from_version, to_version).await?;
            record_migration_marker(pool, &backup_path, from_version, to_version).await?
        }
    };
    validate_migration_marker(&marker, from_version, to_version)?;
    if !is_recoverable_backup(&marker.backup_path) {
        return Err(interrupted_migration_error(&marker));
    }

    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx(operation, error))?
        .detach();
    // SQLite's documented rebuild order requires foreign_keys=OFF before BEGIN.
    // This detached connection is never returned to the pool, including on
    // cancellation. Every rebuilt reference is checked before the commit.
    if change.rebuild_referenced_tables {
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&mut connection)
            .await
            .map_err(|error| map_sqlx(operation, error))?;
    }
    begin_immediate(&mut connection, operation).await?;

    let result = async {
        let metadata = read_metadata(&mut connection).await?;
        if migration_step_is_already_complete(&metadata, to_version) {
            return Ok(());
        }
        let current_marker =
            metadata
                .migration
                .ok_or_else(|| DomainStoreErrorV1::InterruptedMigration {
                    from_version,
                    to_version,
                    backup_name: marker.backup_path.display().to_string(),
                })?;
        validate_migration_marker(&current_marker, from_version, to_version)?;
        if !is_recoverable_backup(&current_marker.backup_path) {
            return Err(interrupted_migration_error(&current_marker));
        }

        execute_statements(&mut connection, change.statements, operation).await?;
        if change.rebuild_referenced_tables
            && sqlx::query("PRAGMA foreign_key_check")
                .fetch_optional(&mut connection)
                .await
                .map_err(|error| map_sqlx(operation, error))?
                .is_some()
        {
            return Err(storage("migration_foreign_key_violation", operation));
        }
        sqlx::query(
            r#"
            UPDATE store_metadata SET
                schema_version = ?1,
                min_reader_version = ?2,
                min_writer_version = ?3,
                migration_from_version = NULL,
                migration_to_version = NULL,
                migration_backup_path = NULL
            WHERE singleton = 1
            "#,
        )
        .bind(i64::from(to_version))
        .bind(i64::from(1_u32))
        .bind(i64::from(1_u32))
        .execute(&mut connection)
        .await
        .map_err(|error| map_sqlx(operation, error))?;
        Ok(())
    }
    .await;

    let result = finish_transaction(&mut connection, operation, result).await;
    let closed = connection
        .close()
        .await
        .map_err(|error| map_sqlx(operation, error));
    result.and(closed)
}
