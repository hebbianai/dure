use dure_app::{
    DomainStoreErrorV1, ProviderCredentialProfileDirectoryNameV1,
    ProviderCredentialProfileRegistrationV1, ProviderCredentialProfileV1, ProviderIdV1,
};
use sqlx::{Row, SqliteConnection, SqlitePool};

use crate::error::{corrupt_identifier, corrupt_row, identity_conflict, map_sqlx, storage};
use crate::schema::{begin_immediate, finish_transaction};

// Client-local account IDs can name the same backend profile. Keep a single
// private directory/generation owner and project each admitted public reference
// from it; aliases never own independent credential generations.
const PROFILE_REFERENCES: &str = r#"
    SELECT p.schema_version, p.provider_id, p.reference_id, p.profile_directory_name,
           p.credential_generation, p.profile_device, p.profile_inode,
           p.reference_id AS canonical_reference_id
    FROM provider_credential_profiles p
    UNION ALL
    SELECT p.schema_version, p.provider_id, a.reference_id, p.profile_directory_name,
           p.credential_generation, p.profile_device, p.profile_inode,
           p.reference_id AS canonical_reference_id
    FROM provider_credential_profile_aliases a
    JOIN provider_credential_profiles p
      ON p.provider_id = a.provider_id AND p.reference_id = a.canonical_reference_id
"#;

pub(crate) async fn register(
    pool: &SqlitePool,
    expected_credential_generation: Option<&str>,
    registration: &ProviderCredentialProfileRegistrationV1,
) -> Result<ProviderCredentialProfileRegistrationV1, DomainStoreErrorV1> {
    registration.validate()?;
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("register_provider_credential_profile", error))?;
    begin_immediate(&mut connection, "register_provider_credential_profile").await?;
    let result = register_on(
        &mut connection,
        expected_credential_generation,
        registration,
    )
    .await;
    finish_transaction(
        &mut connection,
        "register_provider_credential_profile",
        result,
    )
    .await
}

async fn register_on(
    connection: &mut SqliteConnection,
    expected_credential_generation: Option<&str>,
    registration: &ProviderCredentialProfileRegistrationV1,
) -> Result<ProviderCredentialProfileRegistrationV1, DomainStoreErrorV1> {
    reject_cross_namespace_launch_reference(connection, registration).await?;
    let existing = profile_on(
        connection,
        &registration.profile.provider_id,
        &registration.profile.reference_id,
    )
    .await?;
    if existing
        .as_ref()
        .map(|registration| registration.profile.credential_generation.as_str())
        != expected_credential_generation
    {
        return Err(identity_conflict(
            "provider_credential_profile",
            &registration.profile.reference_id,
            "credential profile changed after it was observed",
        ));
    }
    if let Some(existing) = existing {
        let canonical_reference: Option<String> = sqlx::query_scalar(
            "SELECT canonical_reference_id FROM provider_credential_profile_aliases WHERE provider_id = ?1 AND reference_id = ?2",
        )
        .bind(registration.profile.provider_id.as_str())
        .bind(&registration.profile.reference_id)
        .fetch_optional(&mut *connection)
        .await
        .map_err(|error| map_sqlx("register_provider_credential_profile", error))?;
        return update_registration_on(
            connection,
            canonical_reference
                .as_deref()
                .unwrap_or(&registration.profile.reference_id),
            &existing,
            registration,
        )
        .await;
    }

    let directory_owner = sqlx::query(
        "SELECT * FROM provider_credential_profiles WHERE provider_id = ?1 AND profile_directory_name = ?2",
    )
    .bind(registration.profile.provider_id.as_str())
    .bind(registration.profile_directory_name.as_str())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("register_provider_credential_profile", error))?
    .map(decode)
    .transpose()?;
    if let Some(owner) = directory_owner {
        if owner.profile.credential_generation != registration.profile.credential_generation {
            return Err(identity_conflict(
                "provider_credential_profile",
                &registration.profile.reference_id,
                "an alternate reference must observe the current profile generation",
            ));
        }
        update_registration_on(
            connection,
            &owner.profile.reference_id,
            &owner,
            registration,
        )
        .await?;
        sqlx::query(
            "INSERT INTO provider_credential_profile_aliases (provider_id, reference_id, canonical_reference_id) VALUES (?1, ?2, ?3)",
        )
        .bind(registration.profile.provider_id.as_str())
        .bind(&registration.profile.reference_id)
        .bind(&owner.profile.reference_id)
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx("register_provider_credential_profile", error))?;
        return Ok(registration.clone());
    }

    sqlx::query(
        r#"
        INSERT INTO provider_credential_profiles (
            schema_version, provider_id, reference_id, profile_directory_name,
            credential_generation, profile_device, profile_inode
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        "#,
    )
    .bind(i64::from(registration.profile.schema_version))
    .bind(registration.profile.provider_id.as_str())
    .bind(&registration.profile.reference_id)
    .bind(registration.profile_directory_name.as_str())
    .bind(&registration.profile.credential_generation)
    .bind(registration.profile_device.to_string())
    .bind(registration.profile_inode.to_string())
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("register_provider_credential_profile", error))?;
    Ok(registration.clone())
}

async fn update_registration_on(
    connection: &mut SqliteConnection,
    canonical_reference: &str,
    existing: &ProviderCredentialProfileRegistrationV1,
    registration: &ProviderCredentialProfileRegistrationV1,
) -> Result<ProviderCredentialProfileRegistrationV1, DomainStoreErrorV1> {
    if existing.profile_directory_name != registration.profile_directory_name {
        return Err(identity_conflict(
            "provider_credential_profile",
            &registration.profile.reference_id,
            "credential reference cannot be remapped to another profile directory",
        ));
    }
    let same_generation =
        existing.profile.credential_generation == registration.profile.credential_generation;
    if same_generation {
        if existing.profile_device == registration.profile_device
            && existing.profile_inode == registration.profile_inode
        {
            return Ok(registration.clone());
        }
        sqlx::query(
            r#"
                UPDATE provider_credential_profiles SET
                    profile_device = ?1,
                    profile_inode = ?2
                WHERE provider_id = ?3 AND reference_id = ?4
                "#,
        )
        .bind(registration.profile_device.to_string())
        .bind(registration.profile_inode.to_string())
        .bind(registration.profile.provider_id.as_str())
        .bind(canonical_reference)
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx("register_provider_credential_profile", error))?;
        return Ok(registration.clone());
    }
    if existing.profile_inode == registration.profile_inode {
        return Err(identity_conflict(
            "provider_credential_profile",
            &registration.profile.reference_id,
            "one profile inode must retain one credential generation across device remounts",
        ));
    }
    sqlx::query(
        r#"
            UPDATE provider_credential_profiles SET
                credential_generation = ?1,
                profile_device = ?2,
                profile_inode = ?3
            WHERE provider_id = ?4 AND reference_id = ?5
            "#,
    )
    .bind(&registration.profile.credential_generation)
    .bind(registration.profile_device.to_string())
    .bind(registration.profile_inode.to_string())
    .bind(registration.profile.provider_id.as_str())
    .bind(canonical_reference)
    .execute(&mut *connection)
    .await
    .map_err(|error| map_sqlx("register_provider_credential_profile", error))?;
    Ok(registration.clone())
}

async fn reject_cross_namespace_launch_reference(
    connection: &mut SqliteConnection,
    registration: &ProviderCredentialProfileRegistrationV1,
) -> Result<(), DomainStoreErrorV1> {
    let collision = sqlx::query_scalar::<_, String>(&format!(
        r#"
        SELECT reference_id
        FROM ({PROFILE_REFERENCES})
        WHERE provider_id = ?1
          AND reference_id <> ?2
          AND ((reference_id = ?3 AND profile_directory_name <> ?3)
            OR (profile_directory_name = ?2 AND canonical_reference_id <> ?2))
        ORDER BY reference_id
        LIMIT 1
        "#
    ))
    .bind(registration.profile.provider_id.as_str())
    .bind(&registration.profile.reference_id)
    .bind(registration.profile_directory_name.as_str())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("register_provider_credential_profile", error))?;
    if collision.is_some() {
        return Err(identity_conflict(
            "provider_credential_profile",
            &registration.profile.reference_id,
            "public and legacy launch-reference namespaces must remain unambiguous",
        ));
    }
    Ok(())
}

pub(crate) async fn profiles(
    pool: &SqlitePool,
    provider_id: &ProviderIdV1,
) -> Result<Vec<ProviderCredentialProfileV1>, DomainStoreErrorV1> {
    sqlx::query(&format!(
        "SELECT * FROM ({PROFILE_REFERENCES}) WHERE provider_id = ?1 ORDER BY reference_id"
    ))
    .bind(provider_id.as_str())
    .fetch_all(pool)
    .await
    .map_err(|error| map_sqlx("list_provider_credential_profiles", error))?
    .into_iter()
    .map(|row| decode(row).map(|registration| registration.profile))
    .collect()
}

pub(crate) async fn profile(
    pool: &SqlitePool,
    provider_id: &ProviderIdV1,
    reference_id: &str,
) -> Result<Option<ProviderCredentialProfileRegistrationV1>, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("read_provider_credential_profile", error))?;
    profile_on(&mut connection, provider_id, reference_id).await
}

pub(crate) async fn profile_for_launch_reference(
    pool: &SqlitePool,
    provider_id: &ProviderIdV1,
    launch_reference: &str,
) -> Result<Option<ProviderCredentialProfileRegistrationV1>, DomainStoreErrorV1> {
    let rows = sqlx::query(
        &format!(r#"
        SELECT schema_version, provider_id, reference_id, profile_directory_name,
               credential_generation, profile_device, profile_inode
        FROM ({PROFILE_REFERENCES})
        WHERE provider_id = ?1
          AND (reference_id = ?2 OR (reference_id = canonical_reference_id AND profile_directory_name = ?2))
        "#),
    )
    .bind(provider_id.as_str())
    .bind(launch_reference)
    .fetch_all(pool)
    .await
    .map_err(|error| map_sqlx("read_provider_credential_profile_launch_reference", error))?;
    if rows.len() > 1 {
        return Err(identity_conflict(
            "provider_credential_profile",
            provider_id.as_str(),
            "launch reference is ambiguous",
        ));
    }
    rows.into_iter().next().map(decode).transpose()
}

async fn profile_on(
    connection: &mut SqliteConnection,
    provider_id: &ProviderIdV1,
    reference_id: &str,
) -> Result<Option<ProviderCredentialProfileRegistrationV1>, DomainStoreErrorV1> {
    let row = sqlx::query(&format!(
        r#"
        SELECT schema_version, provider_id, reference_id, profile_directory_name,
               credential_generation, profile_device, profile_inode
        FROM ({PROFILE_REFERENCES})
        WHERE provider_id = ?1 AND reference_id = ?2
        "#
    ))
    .bind(provider_id.as_str())
    .bind(reference_id)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_provider_credential_profile", error))?;
    row.map(decode).transpose()
}

fn decode(
    row: sqlx::sqlite::SqliteRow,
) -> Result<ProviderCredentialProfileRegistrationV1, DomainStoreErrorV1> {
    let schema_version = row
        .try_get::<i64, _>("schema_version")
        .map_err(|error| corrupt_row("provider_credential_profiles", error))?
        .try_into()
        .map_err(|_| storage("corrupt_row", "credential profile schema is out of range"))?;
    let provider_id = row
        .try_get::<String, _>("provider_id")
        .map_err(|error| corrupt_row("provider_credential_profiles", error))?;
    let provider_id =
        ProviderIdV1::new(provider_id).map_err(|error| corrupt_identifier("provider_id", error))?;
    let profile_device = decimal_u64(&row, "profile_device")?;
    let profile_inode = decimal_u64(&row, "profile_inode")?;
    let profile_directory_name = ProviderCredentialProfileDirectoryNameV1::new(
        &provider_id,
        row.try_get::<String, _>("profile_directory_name")
            .map_err(|error| corrupt_row("provider_credential_profiles", error))?,
    )
    .map_err(|error| {
        storage(
            "corrupt_provider_credential_profile",
            format!("stored credential profile directory is invalid: {error}"),
        )
    })?;
    let registration = ProviderCredentialProfileRegistrationV1 {
        profile: ProviderCredentialProfileV1 {
            schema_version,
            provider_id,
            reference_id: row
                .try_get("reference_id")
                .map_err(|error| corrupt_row("provider_credential_profiles", error))?,
            credential_generation: row
                .try_get("credential_generation")
                .map_err(|error| corrupt_row("provider_credential_profiles", error))?,
        },
        profile_directory_name,
        profile_device,
        profile_inode,
    };
    registration.validate().map_err(|error| {
        storage(
            "corrupt_provider_credential_profile",
            format!("stored credential profile is invalid: {error}"),
        )
    })?;
    Ok(registration)
}

fn decimal_u64(
    row: &sqlx::sqlite::SqliteRow,
    column: &'static str,
) -> Result<u64, DomainStoreErrorV1> {
    let value: String = row
        .try_get(column)
        .map_err(|error| corrupt_row("provider_credential_profiles", error))?;
    value.parse().map_err(|_| {
        storage(
            "corrupt_provider_credential_profile",
            format!("stored {column} is not an unsigned decimal identity"),
        )
    })
}
