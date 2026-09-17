use dure_app::{
    DomainStoreErrorV1, ProviderCredentialProfileDirectoryNameV1,
    ProviderCredentialProfileRegistrationV1, ProviderCredentialProfileV1, ProviderIdV1,
};
use sqlx::{Row, SqliteConnection, SqlitePool};

use crate::error::{corrupt_identifier, corrupt_row, identity_conflict, map_sqlx, storage};
use crate::schema::{begin_immediate, finish_transaction};

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
                return Ok(existing);
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
            .bind(&registration.profile.reference_id)
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
        .bind(&registration.profile.reference_id)
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx("register_provider_credential_profile", error))?;
        return Ok(registration.clone());
    }

    let aliased_reference: Option<String> = sqlx::query_scalar(
        r#"
        SELECT reference_id
        FROM provider_credential_profiles
        WHERE provider_id = ?1 AND profile_directory_name = ?2
        "#,
    )
    .bind(registration.profile.provider_id.as_str())
    .bind(registration.profile_directory_name.as_str())
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("register_provider_credential_profile", error))?;
    if aliased_reference.is_some() {
        return Err(identity_conflict(
            "provider_credential_profile",
            &registration.profile.reference_id,
            "one profile directory cannot have multiple credential references",
        ));
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

async fn reject_cross_namespace_launch_reference(
    connection: &mut SqliteConnection,
    registration: &ProviderCredentialProfileRegistrationV1,
) -> Result<(), DomainStoreErrorV1> {
    let collision = sqlx::query_scalar::<_, String>(
        r#"
        SELECT reference_id
        FROM provider_credential_profiles
        WHERE provider_id = ?1
          AND reference_id <> ?2
          AND (reference_id = ?3 OR profile_directory_name = ?2)
        ORDER BY reference_id
        LIMIT 1
        "#,
    )
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
        r#"
        SELECT schema_version, provider_id, reference_id, profile_directory_name,
               credential_generation, profile_device, profile_inode
        FROM provider_credential_profiles
        WHERE provider_id = ?1
          AND (reference_id = ?2 OR profile_directory_name = ?2)
        "#,
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
    let row = sqlx::query(
        r#"
        SELECT schema_version, provider_id, reference_id, profile_directory_name,
               credential_generation, profile_device, profile_inode
        FROM provider_credential_profiles
        WHERE provider_id = ?1 AND reference_id = ?2
        "#,
    )
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
