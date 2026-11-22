use super::*;
use crate::SqliteDomainStore;
use crate::session_checkout::commit_or_rollback;

/// A spawn publishes this binding after the Host has started its provider, so
/// a write lock held past the busy timeout waits on the store's retry schedule
/// rather than leaving the running session without its Agent.
pub(crate) async fn upsert(
    store: &SqliteDomainStore,
    authority: &AgentCheckpointBindingAuthorityV1,
) -> Result<(), DomainStoreErrorV1> {
    let mut transaction = store
        .begin_immediate_with_retry("upsert_checkpoint_binding_authority")
        .await?;
    let result = upsert_on(&mut transaction, authority).await;
    commit_or_rollback(transaction, "upsert_checkpoint_binding_authority", result).await
}

pub(crate) async fn upsert_on(
    connection: &mut sqlx::SqliteConnection,
    authority: &AgentCheckpointBindingAuthorityV1,
) -> Result<(), DomainStoreErrorV1> {
    authority.validate()?;
    let binding = &authority.binding;
    reject_other_exact_generation_owner(connection, authority).await?;
    let existing_authority = authority_on(connection, &binding.agent_id).await?;
    if existing_authority.as_ref() != Some(authority) {
        crate::agent_runtime_transition::ensure_target_activation_on(connection, &binding.agent_id)
            .await?;
    }
    match session_binding_on(connection, &binding.agent_id).await? {
        None => {
            sqlx::query(
                r#"
                INSERT INTO session_bindings (
                    agent_id, runtime_kind_id, session_id,
                    provider_conversation_id, credential_reference_id,
                    binding_generation, bound_at_ms
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                "#,
            )
            .bind(binding.agent_id.as_str())
            .bind(binding.runtime_kind_id.as_str())
            .bind(&binding.session_id)
            .bind(&binding.provider_conversation_id)
            .bind(&binding.credential_reference_id)
            .bind(binding.binding_generation)
            .bind(binding.bound_at_ms)
            .execute(&mut *connection)
            .await
            .map_err(|error| map_sqlx("upsert_checkpoint_binding_authority", error))?;
        }
        Some(existing) if existing == *binding => {}
        Some(existing) if binding.binding_generation <= existing.binding_generation => {
            return Err(identity_conflict(
                "session_binding",
                binding.agent_id.as_str(),
                "a generation may only be replayed exactly or advance",
            ));
        }
        Some(existing) if binding.bound_at_ms < existing.bound_at_ms => {
            return Err(identity_conflict(
                "session_binding",
                binding.agent_id.as_str(),
                "boundAtMs may not move backward when a generation advances",
            ));
        }
        Some(_) => update_binding_on(connection, binding).await?,
    }
    match existing_authority {
        None => insert_authority(connection, authority).await?,
        Some(existing) if existing == *authority => {}
        Some(existing)
            if authority.binding.binding_generation <= existing.binding.binding_generation =>
        {
            return Err(identity_conflict(
                "agent_checkpoint_binding_authority",
                binding.agent_id.as_str(),
                "a generation may only be replayed exactly or advance",
            ));
        }
        Some(existing) if authority.updated_at_ms < existing.updated_at_ms => {
            return Err(identity_conflict(
                "agent_checkpoint_binding_authority",
                binding.agent_id.as_str(),
                "updatedAtMs may not move backward when a generation advances",
            ));
        }
        Some(_) => update_authority(connection, authority).await?,
    }
    Ok(())
}
