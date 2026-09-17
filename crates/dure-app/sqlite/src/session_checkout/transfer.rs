use super::*;

impl SqliteDomainStore {
    /// Move one retained resource to an already selected replacement identity.
    /// The runtime reservation callback must not launch a provider. Both it and
    /// owner publication serialize against claim admission and logical close.
    /// Replay compares the immutable claim, so an old owner cannot reclaim it.
    pub async fn transfer_session_checkout_with<F, Fut, E>(
        &self,
        expected: &SessionCheckoutBindingV1,
        target: &SessionCheckoutIdentityV1,
        reserve_runtime: F,
    ) -> Result<SessionCheckoutRecordV1, E>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<(), E>>,
        E: From<DomainStoreErrorV1>,
    {
        self.transfer_session_checkout_with_target(expected, target, None, reserve_runtime)
            .await
    }

    /// A completed runtime successor already supplies its exact close target.
    /// Persist it in the same owner transaction, so response loss cannot leave
    /// the transferred claim dependent on a disappearing discovery descriptor.
    pub async fn transfer_session_checkout_with_target<F, Fut, E>(
        &self,
        expected: &SessionCheckoutBindingV1,
        target: &SessionCheckoutIdentityV1,
        close_payload: Option<&serde_json::Value>,
        reserve_runtime: F,
    ) -> Result<SessionCheckoutRecordV1, E>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<(), E>>,
        E: From<DomainStoreErrorV1>,
    {
        let mut transaction = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(|error| map_sqlx("transfer_session_checkout", error))?;
        let record = transfer_on(
            &mut transaction,
            expected,
            target,
            close_payload,
            reserve_runtime,
        )
        .await?;
        transaction
            .commit()
            .await
            .map_err(|error| map_sqlx("transfer_session_checkout", error))?;
        Ok(record)
    }
}

/// Compose resource transfer with another durable owner publication. The
/// caller owns commit/rollback; this function remains the sole transfer writer.
pub(crate) async fn transfer_on<F, Fut, E>(
    connection: &mut sqlx::SqliteConnection,
    expected: &SessionCheckoutBindingV1,
    target: &SessionCheckoutIdentityV1,
    close_payload: Option<&serde_json::Value>,
    reserve_runtime: F,
) -> Result<SessionCheckoutRecordV1, E>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<(), E>>,
    E: From<DomainStoreErrorV1>,
{
    let record = read_registration(connection, &expected.claim_id)
        .await?
        .ok_or_else(|| storage("session_checkout_unprepared", "binding is not durable"))?;
    let destination = SessionCheckoutBindingV1 {
        identity: target.clone(),
        ..expected.clone()
    };
    let replay = record.binding == destination;
    if replay {
        // Response-loss replay must neither reserve again nor reopen a
        // destination that has since begun or completed its own close.
        if close_payload
            .zip(record.close_payload.as_ref())
            .is_some_and(|(supplied, saved)| supplied != saved)
        {
            return Err(identity_conflict(
                "session_checkout_close",
                target.owner_id().as_str(),
                "the transferred owner has a different retained close target",
            )
            .into());
        }
    } else {
        if record.binding != *expected {
            return Err(identity_conflict(
                "session_checkout_binding",
                expected.claim_id.as_str(),
                "the checkout claim no longer has the expected source binding",
            )
            .into());
        }
        if record.admission != SessionCheckoutAdmissionV1::Open {
            return Err(storage(
                "session_checkout_closing",
                "checkout claim admission has been closed by this product operation",
            )
            .into());
        }
        let target_owner = read(connection, target).await?;
        if matches!(
            target_owner,
            Some(OwnerRecord::Closing | OwnerRecord::Closed)
        ) {
            return Err(storage(
                "session_checkout_closing",
                "the replacement closed before checkout transfer",
            )
            .into());
        }
        if target_owner.is_some() {
            return Err(identity_conflict(
                "session_checkout_binding",
                target.owner_id().as_str(),
                "the replacement already owns another checkout claim",
            )
            .into());
        }
        reserve_runtime().await?;
    }
    // Old transfers could commit ownership before remembering the target.
    // Complete that missing fact without reserving again or changing close
    // admission; legacy retries without a payload preserve newer state.
    let close_payload = if replay {
        close_payload.or(record.close_payload.as_ref())
    } else {
        close_payload
    };
    let serialized = serde_json::to_string(&destination)
        .map_err(|error| serialization("session_checkout_binding", error))?;
    let serialized_close = close_payload
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| serialization("session_checkout_close", error))?;
    sqlx::query(
            "UPDATE session_checkout_bindings SET owner_id = ?2, binding_json = ?3, close_payload_json = ?4 \
             WHERE registration_id = ?1",
        )
        .bind(expected.claim_id.as_str())
        .bind(target.owner_id().as_str())
        .bind(serialized)
        .bind(serialized_close)
        .execute(connection)
        .await
        .map_err(|error| map_sqlx("transfer_session_checkout", error))?;
    Ok(SessionCheckoutRecordV1 {
        binding: destination,
        admission: record.admission,
        close_payload: close_payload.cloned(),
    })
}
