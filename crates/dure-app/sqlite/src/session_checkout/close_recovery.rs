use super::*;
use dure_app::GitCheckoutRegistrationV1;
use sqlx::sqlite::SqliteRow;

impl SqliteDomainStore {
    /// Retained product work, not Git membership or permission to stop a runtime.
    /// A final SQL checkpoint can still be pending after its Git claim is gone.
    pub async fn session_checkout_recovery_candidates(
        &self,
        registration: &GitCheckoutRegistrationV1,
        namespaces: &[String],
    ) -> Result<Vec<SessionCheckoutRecordV1>, DomainStoreErrorV1> {
        let namespaces = serde_json::to_string(namespaces)
            .map_err(|error| serialization("session_checkout_namespaces", error))?;
        let instance = &registration.instance;
        let rows = sqlx::query(
            "SELECT registration_id, owner_id, binding_json, admission, close_payload_json \
             FROM session_checkout_bindings WHERE admission != 'closed' \
             AND json_extract(binding_json, '$.identity.runtimeNamespace') IN (SELECT value FROM json_each(?1)) \
             AND json_extract(binding_json, '$.registration.repositoryPath') = ?2 \
             AND json_extract(binding_json, '$.registration.instance.schemaVersion') = ?3 \
             AND json_extract(binding_json, '$.registration.instance.canonicalPath') = ?4 \
             AND json_extract(binding_json, '$.registration.instance.gitCommonDir') = ?5 \
             AND json_extract(binding_json, '$.registration.instance.gitDir') = ?6 \
             AND json_extract(binding_json, '$.registration.instance.instanceToken') = ?7",
        )
        .bind(namespaces)
        .bind(&registration.repository_path)
        .bind(i64::from(instance.schema_version))
        .bind(&instance.canonical_path)
        .bind(&instance.git_common_dir)
        .bind(&instance.git_dir)
        .bind(&instance.instance_token)
        .fetch_all(&self.pool)
        .await
        .map_err(|error| map_sqlx("read_session_checkout_recovery", error))?;
        decode_targets(rows)
    }

    /// Directory-only resources use the same product close journal as exact
    /// Git resources. The caller supplies the shared retention authority's IDs.
    pub async fn directory_checkout_recovery_candidates(
        &self,
        claims: &[OperationIdV1],
        namespaces: &[String],
    ) -> Result<Vec<SessionCheckoutRecordV1>, DomainStoreErrorV1> {
        let claims = serde_json::to_string(claims)
            .map_err(|error| serialization("directory_checkout_claims", error))?;
        let namespaces = serde_json::to_string(namespaces)
            .map_err(|error| serialization("session_checkout_namespaces", error))?;
        let rows = sqlx::query(
            "SELECT registration_id, owner_id, binding_json, admission, close_payload_json \
             FROM session_checkout_bindings WHERE admission != 'closed' \
             AND registration_id IN (SELECT value FROM json_each(?1)) \
             AND json_extract(binding_json, '$.registration') IS NULL \
             AND json_extract(binding_json, '$.identity.runtimeNamespace') IN (SELECT value FROM json_each(?2))",
        )
        .bind(claims)
        .bind(namespaces)
        .fetch_all(&self.pool)
        .await
        .map_err(|error| map_sqlx("read_directory_checkout_recovery", error))?;
        decode_targets(rows)
    }

    /// Retain immutable cleanup input before exposing a created runtime. This
    /// does not close admission; process retirement remains the runtime's fact.
    pub async fn remember_session_checkout_close_target(
        &self,
        identity: &SessionCheckoutIdentityV1,
        payload: &serde_json::Value,
    ) -> Result<Option<SessionCheckoutRecordV1>, DomainStoreErrorV1> {
        self.transition_session_checkout(
            identity,
            None,
            Some(payload),
            CloseTransition::RememberTarget,
        )
        .await
    }

    /// Freeze a runtime's exact close inputs in the same transaction that
    /// closes claim admission. Replays cannot substitute another target.
    pub async fn begin_session_checkout_close_with(
        &self,
        identity: &SessionCheckoutIdentityV1,
        payload: &serde_json::Value,
    ) -> Result<Option<SessionCheckoutRecordV1>, DomainStoreErrorV1> {
        self.transition_session_checkout(identity, None, Some(payload), CloseTransition::Begin)
            .await
    }

    /// Return retained cleanup inputs for this exact logical address.
    /// Discovery absence never creates a close request or a resource binding.
    pub async fn session_checkout_close_targets(
        &self,
        namespace: &str,
        workspace_id: &str,
        session_id: &str,
    ) -> Result<Vec<SessionCheckoutRecordV1>, DomainStoreErrorV1> {
        let rows = sqlx::query(
            "SELECT registration_id, owner_id, binding_json, admission, close_payload_json \
             FROM session_checkout_bindings WHERE admission != 'closed' AND close_payload_json IS NOT NULL \
             AND json_extract(binding_json, '$.identity.runtimeNamespace') = ?1 \
             AND json_extract(binding_json, '$.identity.owner.workspaceId') = ?2 \
             AND json_extract(binding_json, '$.identity.owner.sessionId') = ?3",
        )
        .bind(namespace)
        .bind(workspace_id)
        .bind(session_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|error| map_sqlx("read_session_checkout_closes", error))?;
        decode_targets(rows)
    }
}

fn decode_targets(
    rows: Vec<SqliteRow>,
) -> Result<Vec<SessionCheckoutRecordV1>, DomainStoreErrorV1> {
    rows.into_iter()
        .map(|row| {
            row::decode_row(Some(row))?
                .and_then(OwnerRecord::into_binding)
                .ok_or_else(|| {
                    storage(
                        "session_checkout_close_unbound",
                        "a pending close lost its binding",
                    )
                })
        })
        .collect()
}
