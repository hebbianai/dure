use super::*;

/// Select a resource in the caller's transaction. Runtime reservation and Agent
/// publication use this same writer, never a separately committed binding.
pub(crate) async fn prepare_on<F, Fut, E>(
    connection: &mut sqlx::SqliteConnection,
    binding: &SessionCheckoutBindingV1,
    reserve_runtime: F,
) -> Result<SessionCheckoutRecordV1, E>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<(), E>>,
    E: From<DomainStoreErrorV1>,
{
    let existing = read(connection, &binding.identity).await?;
    let record = match existing {
        Some(OwnerRecord::Bound(record)) => {
            if record.binding != *binding {
                return Err(identity_conflict(
                    "session_checkout_binding",
                    binding.claim_id.as_str(),
                    "the create identity already names a different checkout binding",
                )
                .into());
            }
            *record
        }
        Some(OwnerRecord::Closing | OwnerRecord::Closed) => {
            return Err(storage(
                "session_checkout_closing",
                "this runtime owner closed before selecting a checkout",
            )
            .into());
        }
        None => {
            if read_registration(connection, &binding.claim_id)
                .await?
                .is_some()
            {
                return Err(identity_conflict(
                    "session_checkout_binding",
                    binding.claim_id.as_str(),
                    "the checkout claim has another owner",
                )
                .into());
            }
            let serialized = serde_json::to_string(binding)
                .map_err(|error| serialization("session_checkout_binding", error))?;
            sqlx::query(
                "INSERT INTO session_checkout_bindings \
                 (registration_id, owner_id, binding_json, admission) VALUES (?1, ?2, ?3, 'open')",
            )
            .bind(binding.claim_id.as_str())
            .bind(binding.identity.owner_id().as_str())
            .bind(serialized)
            .execute(&mut *connection)
            .await
            .map_err(|error| map_sqlx("prepare_session_checkout", error))?;
            SessionCheckoutRecordV1 {
                binding: binding.clone(),
                admission: SessionCheckoutAdmissionV1::Open,
                close_payload: None,
            }
        }
    };
    if record.admission == SessionCheckoutAdmissionV1::Open {
        reserve_runtime().await?;
    }
    Ok(record)
}
