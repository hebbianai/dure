use std::collections::BTreeMap;

use dure_app::{
    DomainStoreErrorV1, OperationIdV1, PhysicalTargetKeyV2, PluginApplyJournalEventBodyV2,
    PluginApplyJournalEventV2, PluginNativePhysicalTargetBindingV2,
    PluginNativePhysicalTargetDigestV2, PluginNativePhysicalTargetRoleV2,
    validate_plugin_native_physical_target_bindings,
};
use sqlx::sqlite::SqliteRow;
use sqlx::{Row, SqliteConnection, SqlitePool};

use crate::error::{corrupt_identifier, corrupt_row, identity_conflict, map_sqlx, storage};
use crate::schema::{begin_immediate, finish_transaction};

#[derive(Clone, Debug, Eq, PartialEq)]
struct ProjectedTargetBinding {
    binding: PluginNativePhysicalTargetBindingV2,
    bound_by_operation_id: String,
    bound_by_event_id: String,
    bound_at_ms: i64,
}

impl ProjectedTargetBinding {
    fn provenance(&self) -> (i64, &str, &str) {
        (
            self.bound_at_ms,
            &self.bound_by_operation_id,
            &self.bound_by_event_id,
        )
    }

    fn retain_canonical_provenance(&mut self, event: &PluginApplyJournalEventV2) {
        let candidate = (
            event.recorded_at_ms,
            event.operation_id.as_str(),
            event.event_id.as_str(),
        );
        if candidate < self.provenance() {
            self.bound_at_ms = event.recorded_at_ms;
            self.bound_by_operation_id = event.operation_id.as_str().into();
            self.bound_by_event_id = event.event_id.as_str().into();
        }
    }
}

pub(crate) async fn validate_operation_bindings(
    pool: &SqlitePool,
    operation_id: &OperationIdV1,
    bindings: &[PluginNativePhysicalTargetBindingV2],
) -> Result<(), DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("validate_plugin_native_target_bindings", error))?;
    sqlx::query("BEGIN DEFERRED")
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx("validate_plugin_native_target_bindings", error))?;
    let result = async {
        validate_binding_projection(&mut connection).await?;
        validate_operation_bindings_on(&mut connection, operation_id, bindings).await
    }
    .await;
    finish_transaction(
        &mut connection,
        "validate_plugin_native_target_bindings",
        result,
    )
    .await
}

pub(crate) async fn persist_started_bindings(
    connection: &mut SqliteConnection,
    event: &PluginApplyJournalEventV2,
) -> Result<(), DomainStoreErrorV1> {
    let PluginApplyJournalEventBodyV2::Started {
        target_bindings,
        steps,
        ..
    } = &event.body
    else {
        return Ok(());
    };
    let bindings = target_bindings.as_deref().ok_or_else(|| {
        storage(
            "legacy_plugin_native_target_unbound",
            "new plugin apply operations must carry durable physical target bindings",
        )
    })?;
    validate_plugin_native_physical_target_bindings(steps, bindings)
        .map_err(|error| storage("invalid_plugin_native_target_binding", error.to_string()))?;
    persist_binding_batch(connection, event, bindings).await
}

pub(crate) async fn validate_started_bindings(
    connection: &mut SqliteConnection,
    event: &PluginApplyJournalEventV2,
) -> Result<(), DomainStoreErrorV1> {
    let PluginApplyJournalEventBodyV2::Started {
        target_bindings,
        steps,
        ..
    } = &event.body
    else {
        return Ok(());
    };
    let Some(bindings) = target_bindings.as_deref() else {
        return Ok(());
    };
    validate_plugin_native_physical_target_bindings(steps, bindings)
        .map_err(|error| storage("invalid_plugin_native_target_binding", error.to_string()))?;
    for binding in bindings {
        let stored = binding_by_key(connection, &binding.key)
            .await?
            .ok_or_else(|| {
                storage(
                    "missing_plugin_native_target_binding",
                    format!(
                        "physical target {:?} has no durable projection",
                        binding.key.as_str()
                    ),
                )
            })?;
        ensure_exact_binding(&stored, binding)?;
    }
    Ok(())
}

pub(crate) async fn validate_binding_projection(
    connection: &mut SqliteConnection,
) -> Result<(), DomainStoreErrorV1> {
    let events = crate::plugin_apply::load_all_events(connection).await?;
    let mut expected = BTreeMap::<PhysicalTargetKeyV2, ProjectedTargetBinding>::new();
    let mut canonical_owners = BTreeMap::<String, PhysicalTargetKeyV2>::new();
    let mut object_owners = BTreeMap::<String, PhysicalTargetKeyV2>::new();
    let mut authority_generation = None::<PluginNativePhysicalTargetDigestV2>;
    for event in &events {
        let PluginApplyJournalEventBodyV2::Started {
            target_bindings: Some(bindings),
            steps,
            ..
        } = &event.body
        else {
            continue;
        };
        validate_plugin_native_physical_target_bindings(steps, bindings).map_err(|error| {
            storage(
                "corrupt_plugin_native_target_binding_projection",
                error.to_string(),
            )
        })?;
        for binding in bindings {
            if authority_generation
                .as_ref()
                .is_some_and(|generation| generation != &binding.authority_generation_identity)
            {
                return Err(storage(
                    "corrupt_plugin_native_target_binding_projection",
                    "journal contains multiple native target authority generations",
                ));
            }
            authority_generation
                .get_or_insert_with(|| binding.authority_generation_identity.clone());
            ensure_journal_alias(
                &mut canonical_owners,
                &binding.canonical_path_identity,
                &binding.key,
                "canonical path",
            )?;
            ensure_journal_alias(
                &mut object_owners,
                &binding.filesystem_object_identity,
                &binding.key,
                "filesystem object",
            )?;
            match expected.get_mut(&binding.key) {
                Some(existing) if existing.binding != *binding => {
                    return Err(storage(
                        "corrupt_plugin_native_target_binding_projection",
                        format!(
                            "journal rebinds physical target key {:?}",
                            binding.key.as_str()
                        ),
                    ));
                }
                Some(existing) => existing.retain_canonical_provenance(event),
                None => {
                    expected.insert(
                        binding.key.clone(),
                        ProjectedTargetBinding {
                            binding: binding.clone(),
                            bound_by_operation_id: event.operation_id.as_str().into(),
                            bound_by_event_id: event.event_id.as_str().into(),
                            bound_at_ms: event.recorded_at_ms,
                        },
                    );
                }
            }
        }
    }

    let rows = sqlx::query(
        r#"
        SELECT
            physical_target_key,
            role,
            canonical_path_identity,
            filesystem_object_identity,
            authority_generation_identity,
            authority_identity,
            binding_identity,
            bound_by_operation_id,
            bound_by_event_id,
            bound_at_ms
        FROM plugin_native_target_bindings
        ORDER BY physical_target_key
        "#,
    )
    .fetch_all(&mut *connection)
    .await
    .map_err(|error| map_sqlx("validate_plugin_native_target_binding_projection", error))?;
    let mut actual = BTreeMap::new();
    for row in rows {
        let projected = projected_binding_from_row(row)?;
        actual.insert(projected.binding.key.clone(), projected);
    }
    if actual != expected {
        return Err(storage(
            "corrupt_plugin_native_target_binding_projection",
            "native target binding projection differs from the complete journal history",
        ));
    }
    Ok(())
}

fn ensure_journal_alias(
    owners: &mut BTreeMap<String, PhysicalTargetKeyV2>,
    identity: &PluginNativePhysicalTargetDigestV2,
    key: &PhysicalTargetKeyV2,
    label: &str,
) -> Result<(), DomainStoreErrorV1> {
    if let Some(owner) = owners.insert(identity.as_str().into(), key.clone()) {
        if owner != *key {
            return Err(storage(
                "corrupt_plugin_native_target_binding_projection",
                format!(
                    "journal aliases {label} between keys {:?} and {:?}",
                    owner.as_str(),
                    key.as_str()
                ),
            ));
        }
    }
    Ok(())
}

pub(crate) async fn rebuild_bindings(pool: &SqlitePool) -> Result<usize, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("rebuild_plugin_native_target_bindings", error))?;
    begin_immediate(&mut connection, "rebuild_plugin_native_target_bindings").await?;
    let result = async {
        let events = crate::plugin_apply::load_all_events(&mut connection).await?;
        sqlx::query("DELETE FROM plugin_native_target_bindings")
            .execute(&mut *connection)
            .await
            .map_err(|error| map_sqlx("rebuild_plugin_native_target_bindings", error))?;
        for event in &events {
            let PluginApplyJournalEventBodyV2::Started {
                target_bindings: Some(bindings),
                steps,
                ..
            } = &event.body
            else {
                continue;
            };
            validate_plugin_native_physical_target_bindings(steps, bindings).map_err(|error| {
                storage("corrupt_plugin_native_target_binding", error.to_string())
            })?;
            persist_binding_batch(&mut connection, event, bindings).await?;
        }
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM plugin_native_target_bindings")
            .fetch_one(&mut *connection)
            .await
            .map_err(|error| map_sqlx("rebuild_plugin_native_target_bindings", error))?;
        usize::try_from(count).map_err(|_| {
            storage(
                "invalid_plugin_native_target_binding_count",
                "physical target binding count is outside usize",
            )
        })
    }
    .await;
    finish_transaction(
        &mut connection,
        "rebuild_plugin_native_target_bindings",
        result,
    )
    .await
}

async fn validate_operation_bindings_on(
    connection: &mut SqliteConnection,
    operation_id: &OperationIdV1,
    bindings: &[PluginNativePhysicalTargetBindingV2],
) -> Result<(), DomainStoreErrorV1> {
    let receipt = crate::plugin_apply::validated_receipt_by_operation(connection, operation_id)
        .await?
        .ok_or_else(|| DomainStoreErrorV1::NotFound {
            entity: "plugin_apply_operation",
            id: operation_id.as_str().into(),
        })?;
    let expected = receipt.target_bindings.as_deref().ok_or_else(|| {
        storage(
            "legacy_plugin_native_target_unbound",
            format!("operation {operation_id} has no durable physical target binding"),
        )
    })?;
    if expected != bindings {
        return Err(identity_conflict(
            "plugin_native_operation_target_bindings",
            operation_id.as_str(),
            "current host identities differ from the operation binding snapshot",
        ));
    }
    validate_plugin_native_physical_target_bindings(&receipt.steps, bindings)
        .map_err(|error| storage("invalid_plugin_native_target_binding", error.to_string()))?;
    for binding in bindings {
        let stored = binding_by_key(connection, &binding.key)
            .await?
            .ok_or_else(|| {
                storage(
                    "missing_plugin_native_target_binding",
                    format!(
                        "physical target {:?} has no durable projection",
                        binding.key.as_str()
                    ),
                )
            })?;
        ensure_exact_binding(&stored, binding)?;
    }
    Ok(())
}

async fn persist_binding_batch(
    connection: &mut SqliteConnection,
    event: &PluginApplyJournalEventV2,
    bindings: &[PluginNativePhysicalTargetBindingV2],
) -> Result<(), DomainStoreErrorV1> {
    let Some(authority_generation) = bindings
        .first()
        .map(|binding| &binding.authority_generation_identity)
    else {
        return Err(storage(
            "invalid_plugin_native_target_binding",
            "physical target binding batch must not be empty",
        ));
    };
    if bindings
        .iter()
        .any(|binding| &binding.authority_generation_identity != authority_generation)
    {
        return Err(identity_conflict(
            "plugin_native_target_authority",
            "singleton",
            "one binding batch used multiple host authority generations",
        ));
    }
    let stored_authority: Option<String> = sqlx::query_scalar(
        "SELECT authority_generation_identity FROM plugin_native_target_bindings LIMIT 1",
    )
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_plugin_native_target_authority", error))?;
    if stored_authority
        .as_deref()
        .is_some_and(|stored| stored != authority_generation.as_str())
    {
        return Err(identity_conflict(
            "plugin_native_target_authority",
            "singleton",
            "host authority generation changed",
        ));
    }
    let mut missing = Vec::new();
    let mut provenance_updates = Vec::new();
    let mut canonical_owners = BTreeMap::<&str, &PhysicalTargetKeyV2>::new();
    let mut object_owners = BTreeMap::<&str, &PhysicalTargetKeyV2>::new();
    for binding in bindings {
        if let Some(owner) =
            canonical_owners.insert(binding.canonical_path_identity.as_str(), &binding.key)
        {
            return Err(alias_conflict(&binding.key, owner, "canonical path"));
        }
        if let Some(owner) =
            object_owners.insert(binding.filesystem_object_identity.as_str(), &binding.key)
        {
            return Err(alias_conflict(&binding.key, owner, "filesystem object"));
        }
        match projected_binding_by_key(connection, &binding.key).await? {
            Some(existing) => {
                ensure_exact_binding(&existing.binding, binding)?;
                let candidate = (
                    event.recorded_at_ms,
                    event.operation_id.as_str(),
                    event.event_id.as_str(),
                );
                if candidate < existing.provenance() {
                    provenance_updates.push(binding);
                }
            }
            None => missing.push(binding),
        }
        reject_reverse_alias(connection, binding).await?;
    }
    for binding in provenance_updates {
        sqlx::query(
            r#"
            UPDATE plugin_native_target_bindings
            SET bound_by_operation_id = ?2,
                bound_by_event_id = ?3,
                bound_at_ms = ?4
            WHERE physical_target_key = ?1
            "#,
        )
        .bind(binding.key.as_str())
        .bind(event.operation_id.as_str())
        .bind(event.event_id.as_str())
        .bind(event.recorded_at_ms)
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx("update_plugin_native_target_binding_provenance", error))?;
    }
    for binding in missing {
        sqlx::query(
            r#"
            INSERT INTO plugin_native_target_bindings (
                physical_target_key,
                role,
                canonical_path_identity,
                filesystem_object_identity,
                authority_generation_identity,
                authority_identity,
                binding_identity,
                bound_by_operation_id,
                bound_by_event_id,
                bound_at_ms
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            "#,
        )
        .bind(binding.key.as_str())
        .bind(binding.role.as_str())
        .bind(binding.canonical_path_identity.as_str())
        .bind(binding.filesystem_object_identity.as_str())
        .bind(binding.authority_generation_identity.as_str())
        .bind(binding.authority_identity.as_str())
        .bind(binding.binding_identity.as_str())
        .bind(event.operation_id.as_str())
        .bind(event.event_id.as_str())
        .bind(event.recorded_at_ms)
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx("persist_plugin_native_target_binding", error))?;
    }
    Ok(())
}

async fn reject_reverse_alias(
    connection: &mut SqliteConnection,
    binding: &PluginNativePhysicalTargetBindingV2,
) -> Result<(), DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT physical_target_key
        FROM plugin_native_target_bindings
        WHERE canonical_path_identity = ?1 OR filesystem_object_identity = ?2
        "#,
    )
    .bind(binding.canonical_path_identity.as_str())
    .bind(binding.filesystem_object_identity.as_str())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_plugin_native_target_alias", error))?;
    let Some(row) = row else {
        return Ok(());
    };
    let owner: String = row
        .try_get("physical_target_key")
        .map_err(|error| corrupt_row("plugin_native_target_bindings", error))?;
    if owner == binding.key.as_str() {
        Ok(())
    } else {
        Err(identity_conflict(
            "plugin_native_physical_target",
            binding.key.as_str(),
            format!("physical identity is already bound to key {owner:?}"),
        ))
    }
}

async fn binding_by_key(
    connection: &mut SqliteConnection,
    key: &PhysicalTargetKeyV2,
) -> Result<Option<PluginNativePhysicalTargetBindingV2>, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT
            physical_target_key,
            role,
            canonical_path_identity,
            filesystem_object_identity,
            authority_generation_identity,
            authority_identity,
            binding_identity
        FROM plugin_native_target_bindings
        WHERE physical_target_key = ?1
        "#,
    )
    .bind(key.as_str())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_plugin_native_target_binding", error))?;
    row.map(binding_from_row).transpose()
}

async fn projected_binding_by_key(
    connection: &mut SqliteConnection,
    key: &PhysicalTargetKeyV2,
) -> Result<Option<ProjectedTargetBinding>, DomainStoreErrorV1> {
    let row = sqlx::query(
        r#"
        SELECT
            physical_target_key,
            role,
            canonical_path_identity,
            filesystem_object_identity,
            authority_generation_identity,
            authority_identity,
            binding_identity,
            bound_by_operation_id,
            bound_by_event_id,
            bound_at_ms
        FROM plugin_native_target_bindings
        WHERE physical_target_key = ?1
        "#,
    )
    .bind(key.as_str())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_projected_plugin_native_target_binding", error))?;
    row.map(projected_binding_from_row).transpose()
}

fn binding_from_row(
    row: SqliteRow,
) -> Result<PluginNativePhysicalTargetBindingV2, DomainStoreErrorV1> {
    let key: String = row
        .try_get("physical_target_key")
        .map_err(|error| corrupt_row("plugin_native_target_bindings", error))?;
    let role: String = row
        .try_get("role")
        .map_err(|error| corrupt_row("plugin_native_target_bindings", error))?;
    let canonical: String = row
        .try_get("canonical_path_identity")
        .map_err(|error| corrupt_row("plugin_native_target_bindings", error))?;
    let object: String = row
        .try_get("filesystem_object_identity")
        .map_err(|error| corrupt_row("plugin_native_target_bindings", error))?;
    let authority: String = row
        .try_get("authority_generation_identity")
        .map_err(|error| corrupt_row("plugin_native_target_bindings", error))?;
    let target_authority: String = row
        .try_get("authority_identity")
        .map_err(|error| corrupt_row("plugin_native_target_bindings", error))?;
    let binding_identity: String = row
        .try_get("binding_identity")
        .map_err(|error| corrupt_row("plugin_native_target_bindings", error))?;
    Ok(PluginNativePhysicalTargetBindingV2 {
        key: PhysicalTargetKeyV2::new(key)
            .map_err(|error| corrupt_identifier("physical_target_key", error))?,
        role: match role.as_str() {
            "profile_root" => PluginNativePhysicalTargetRoleV2::ProfileRoot,
            "workspace_root" => PluginNativePhysicalTargetRoleV2::WorkspaceRoot,
            _ => {
                return Err(storage(
                    "corrupt_plugin_native_target_binding",
                    format!("unknown physical target role {role:?}"),
                ));
            }
        },
        canonical_path_identity: PluginNativePhysicalTargetDigestV2::new(canonical)
            .map_err(|error| corrupt_identifier("canonical_path_identity", error))?,
        filesystem_object_identity: PluginNativePhysicalTargetDigestV2::new(object)
            .map_err(|error| corrupt_identifier("filesystem_object_identity", error))?,
        authority_generation_identity: PluginNativePhysicalTargetDigestV2::new(authority)
            .map_err(|error| corrupt_identifier("authority_generation_identity", error))?,
        authority_identity: PluginNativePhysicalTargetDigestV2::new(target_authority)
            .map_err(|error| corrupt_identifier("authority_identity", error))?,
        binding_identity: PluginNativePhysicalTargetDigestV2::new(binding_identity)
            .map_err(|error| corrupt_identifier("binding_identity", error))?,
    })
}

fn projected_binding_from_row(
    row: SqliteRow,
) -> Result<ProjectedTargetBinding, DomainStoreErrorV1> {
    let bound_by_operation_id: String = row
        .try_get("bound_by_operation_id")
        .map_err(|error| corrupt_row("plugin_native_target_bindings", error))?;
    let bound_by_event_id: String = row
        .try_get("bound_by_event_id")
        .map_err(|error| corrupt_row("plugin_native_target_bindings", error))?;
    let bound_at_ms: i64 = row
        .try_get("bound_at_ms")
        .map_err(|error| corrupt_row("plugin_native_target_bindings", error))?;
    Ok(ProjectedTargetBinding {
        binding: binding_from_row(row)?,
        bound_by_operation_id,
        bound_by_event_id,
        bound_at_ms,
    })
}

fn ensure_exact_binding(
    stored: &PluginNativePhysicalTargetBindingV2,
    candidate: &PluginNativePhysicalTargetBindingV2,
) -> Result<(), DomainStoreErrorV1> {
    if stored == candidate {
        Ok(())
    } else {
        Err(identity_conflict(
            "plugin_native_physical_target",
            candidate.key.as_str(),
            "canonical path, filesystem object, role, or owner authority changed",
        ))
    }
}

fn alias_conflict(
    candidate: &PhysicalTargetKeyV2,
    owner: &PhysicalTargetKeyV2,
    identity: &str,
) -> DomainStoreErrorV1 {
    identity_conflict(
        "plugin_native_physical_target",
        candidate.as_str(),
        format!("{identity} is also assigned to key {:?}", owner.as_str()),
    )
}
