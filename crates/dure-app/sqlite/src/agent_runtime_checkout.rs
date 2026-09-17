use dure_app::{
    AgentIdV1, AgentRuntimeBindingAuthorityV1, AgentRuntimeSelectionV1,
    AgentRuntimeTransitionRecordV1, AgentRuntimeTransitionStore, DomainStoreErrorV1, OperationIdV1,
    SessionCheckoutBindingV1, SessionCheckoutIdentityV1, SessionCheckoutOwnerV1,
    SessionCheckoutRecordV1,
};
use sqlx::SqliteConnection;

use crate::agent_runtime_transition::{require_current_runtime_authority_on, selection_on};
use crate::error::{corrupt_identifier, identity_conflict, map_sqlx, serialization};
use crate::schema::{begin_immediate, finish_transaction};
use crate::session_checkout::{row::decode_row, transfer::transfer_on};

mod native;
mod registration;
pub(crate) mod roots;

pub(crate) const ADD_CHECKOUT_OWNER: &str = "ALTER TABLE agent_runtime_selections ADD COLUMN checkout_owner_id TEXT REFERENCES session_checkout_bindings(owner_id)";
pub(crate) const ADD_AGENT_CHECKOUT_OWNER: &str = "ALTER TABLE agents ADD COLUMN checkout_owner_id TEXT REFERENCES session_checkout_bindings(owner_id)";

impl crate::SqliteDomainStore {
    /// The selected Agent lifetime, independent of its current provider surface.
    pub async fn agent_runtime_checkout(
        &self,
        agent_id: &AgentIdV1,
    ) -> Result<Option<SessionCheckoutRecordV1>, DomainStoreErrorV1> {
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|error| map_sqlx("read_agent_runtime_checkout", error))?;
        checkout_on(&mut connection, agent_id).await
    }

    /// Attach a legacy resource only while the exact observed Agent selection
    /// and runtime still own it. Transfer and publication commit together.
    pub async fn adopt_agent_runtime_checkout(
        &self,
        selection: &AgentRuntimeSelectionV1,
        authority: &AgentRuntimeBindingAuthorityV1,
        source: &SessionCheckoutBindingV1,
    ) -> Result<Option<SessionCheckoutRecordV1>, DomainStoreErrorV1> {
        selection.validate()?;
        authority.validate_for_selection(selection)?;
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|error| map_sqlx("adopt_agent_runtime_checkout", error))?;
        begin_immediate(&mut connection, "adopt_agent_runtime_checkout").await?;
        let result = async {
            if selection_on(&mut connection, &selection.agent_id)
                .await?
                .as_ref()
                != Some(selection)
            {
                return Err(identity_conflict(
                    "agent runtime checkout",
                    selection.agent_id.as_str(),
                    "the selected resource lifetime changed before adoption",
                ));
            }
            require_current_runtime_authority_on(&mut connection, &selection.agent_id, authority)
                .await?;
            adopt_on(&mut connection, &selection.agent_id, source).await?;
            checkout_on(&mut connection, &selection.agent_id).await
        }
        .await;
        finish_transaction(&mut connection, "adopt_agent_runtime_checkout", result).await
    }

    /// Hmux rehost resolves to a create root, which may itself have been
    /// started by a settings transition. Only that exact target selects ancestry.
    pub async fn agent_runtime_transition_for_native_origin(
        &self,
        agent_id: &AgentIdV1,
        origin: &SessionCheckoutIdentityV1,
    ) -> Result<Option<AgentRuntimeTransitionRecordV1>, DomainStoreErrorV1> {
        let SessionCheckoutOwnerV1::Managed {
            workspace_id,
            session_id,
            idempotency_key,
        } = &origin.owner
        else {
            return Err(DomainStoreErrorV1::InvalidRecord {
                field: "checkoutOrigin",
                reason: "runtime ancestry requires a managed create origin".into(),
            });
        };
        let operation = sqlx::query_scalar::<_, String>(
            "SELECT operation_id FROM agent_runtime_transitions WHERE agent_id = ?1 \
             AND json_extract(record_json, '$.targetLaunchIdempotencyKey') = ?2 \
             AND json_extract(record_json, '$.targetAuthority.authority.runtimeWorkspaceId') = ?3 \
             AND json_extract(record_json, '$.targetAuthority.authority.binding.sessionId') = ?4",
        )
        .bind(agent_id.as_str())
        .bind(idempotency_key)
        .bind(workspace_id)
        .bind(session_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|error| map_sqlx("read_agent_runtime_checkout_origin", error))?;
        match operation {
            Some(operation) => {
                self.agent_runtime_transition(&OperationIdV1::new(operation).map_err(|error| {
                    corrupt_identifier("agent_runtime_checkout_origin.operation_id", error)
                })?)
                .await
            }
            None => Ok(None),
        }
    }
}

pub(crate) async fn checkout_on(
    connection: &mut SqliteConnection,
    agent_id: &AgentIdV1,
) -> Result<Option<SessionCheckoutRecordV1>, DomainStoreErrorV1> {
    let row = sqlx::query(
            "SELECT checkout.registration_id, checkout.owner_id, checkout.binding_json, \
             checkout.admission, checkout.close_payload_json FROM agents AS agent \
             JOIN session_checkout_bindings AS checkout ON checkout.owner_id = agent.checkout_owner_id \
             WHERE agent.agent_id = ?1",
        ).bind(agent_id.as_str()).fetch_optional(connection).await
            .map_err(|error| map_sqlx("read_agent_runtime_checkout", error))?;
    Ok(decode_row(row)?.and_then(|record| record.into_binding()))
}

async fn owner_on(
    connection: &mut SqliteConnection,
    agent_id: &AgentIdV1,
) -> Result<Option<String>, DomainStoreErrorV1> {
    sqlx::query_scalar::<_, Option<String>>(
        "SELECT checkout_owner_id FROM agents WHERE agent_id = ?1",
    )
    .bind(agent_id.as_str())
    .fetch_optional(connection)
    .await
    .map_err(|error| map_sqlx("read_agent_runtime_checkout", error))?
    .ok_or_else(|| {
        identity_conflict(
            "agent runtime checkout",
            agent_id.as_str(),
            "the Agent resource owner does not exist",
        )
    })
}

/// Publish the resource handoff in the caller's admitted Agent transaction.
/// The Git claim never leaves membership and its opaque incarnation is retained.
pub(crate) async fn adopt_on(
    connection: &mut SqliteConnection,
    agent_id: &AgentIdV1,
    source: &SessionCheckoutBindingV1,
) -> Result<(), DomainStoreErrorV1> {
    let target = source.retained_by_agent(agent_id).identity;
    let owner = target.owner_id();
    if owner_on(connection, agent_id)
        .await?
        .is_some_and(|existing| existing != owner.as_str())
    {
        return Err(identity_conflict(
            "agent runtime checkout",
            agent_id.as_str(),
            "another resource lifetime is selected",
        ));
    }
    // The caller has admitted the exact runtime adoption or close. Retain
    // its resource origin for permanent close, not merely its cwd.
    let origin = serde_json::to_value(&source.identity)
        .map_err(|error| serialization("agent_checkout_origin", error))?;
    transfer_on(connection, source, &target, Some(&origin), || async {
        Ok::<_, DomainStoreErrorV1>(())
    })
    .await?;
    sqlx::query("UPDATE agents SET checkout_owner_id = ?2 WHERE agent_id = ?1")
        .bind(agent_id.as_str())
        .bind(owner.as_str())
        .execute(connection)
        .await
        .map_err(|error| map_sqlx("bind_agent_runtime_checkout", error))?;
    Ok(())
}
