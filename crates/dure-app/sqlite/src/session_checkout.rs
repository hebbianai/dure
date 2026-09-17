use dure_app::{
    DomainStoreErrorV1, OperationIdV1, SessionCheckoutAdmissionV1, SessionCheckoutBindingV1,
    SessionCheckoutIdentityV1, SessionCheckoutRecordV1,
};
use sqlx::{Sqlite, Transaction};
use std::future::Future;

use crate::SqliteDomainStore;
use crate::error::{identity_conflict, map_sqlx, serialization, storage};

mod close_recovery;
pub(crate) mod preparation;
pub(crate) mod row;
pub(crate) mod transfer;
use row::{OwnerRecord, read, read_registration};

#[cfg(test)]
mod tests;

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum CloseTransition {
    RememberTarget,
    Begin,
    Finish,
}

pub(crate) const CREATE_BINDINGS: &str = r#"
CREATE TABLE IF NOT EXISTS session_checkout_bindings (
    owner_id TEXT PRIMARY KEY NOT NULL,
    registration_id TEXT UNIQUE,
    binding_json TEXT,
    close_payload_json TEXT,
    admission TEXT NOT NULL CHECK (admission IN ('open', 'closing', 'closed')),
    CHECK (
        (registration_id IS NOT NULL AND binding_json IS NOT NULL)
        OR (registration_id IS NULL AND binding_json IS NULL AND admission != 'open')
    )
)
"#;

/// Serializes only checkout claim admission against product cleanup. Finish
/// this guard before provider launch; never hold it during runtime stop. A
/// cancelled future rolls its transaction back before the connection is reused.
pub struct SessionCheckoutAdmission {
    pub(crate) transaction: Transaction<'static, Sqlite>,
    pub(crate) binding: SessionCheckoutBindingV1,
    pub(crate) agent_origin: Option<SessionCheckoutIdentityV1>,
    pub(crate) retained: bool,
}

impl SessionCheckoutAdmission {
    pub fn binding(&self) -> &SessionCheckoutBindingV1 {
        &self.binding
    }

    /// This exact Agent root has a committed claim acknowledgement. Merely
    /// preparing an open binding does not establish resource retention.
    pub fn retained(&self) -> bool {
        self.retained
    }

    pub async fn finish(mut self) -> Result<(), DomainStoreErrorV1> {
        if let Some(origin) = &self.agent_origin {
            crate::agent_runtime_checkout::roots::remember_on(
                &mut self.transaction,
                &self.binding,
                origin,
            )
            .await?;
        }
        self.transaction
            .commit()
            .await
            .map_err(|error| map_sqlx("finish_session_checkout_admission", error))
    }
}

impl SqliteDomainStore {
    #[cfg(test)]
    pub async fn prepare_session_checkout(
        &self,
        binding: &SessionCheckoutBindingV1,
    ) -> Result<SessionCheckoutRecordV1, DomainStoreErrorV1> {
        self.prepare_session_checkout_with(binding, || async { Ok(()) })
            .await
    }

    /// Establish the runtime reservation before publishing the binding, and
    /// publish the binding before any Git claim. Cleanup on another connection
    /// cannot observe a binding whose runtime reservation has not completed.
    /// The callback must not launch a provider or acquire its checkout claim.
    pub async fn prepare_session_checkout_with<F, Fut, E>(
        &self,
        binding: &SessionCheckoutBindingV1,
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
            .map_err(|error| map_sqlx("prepare_session_checkout", error))?;
        let record = preparation::prepare_on(&mut transaction, binding, reserve_runtime).await?;
        transaction
            .commit()
            .await
            .map_err(|error| map_sqlx("prepare_session_checkout", error))?;
        Ok(record)
    }

    pub async fn session_checkout(
        &self,
        identity: &SessionCheckoutIdentityV1,
    ) -> Result<Option<SessionCheckoutRecordV1>, DomainStoreErrorV1> {
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|error| map_sqlx("read_session_checkout", error))?;
        Ok(read(&mut connection, identity)
            .await?
            .and_then(OwnerRecord::into_binding))
    }

    /// Resolve a Git-owned claim by its existing primary key. Unknown claims
    /// belong to other producers; never infer their runtime identity.
    pub async fn session_checkout_registration(
        &self,
        registration_id: &OperationIdV1,
    ) -> Result<Option<SessionCheckoutRecordV1>, DomainStoreErrorV1> {
        let mut connection = self
            .pool
            .acquire()
            .await
            .map_err(|error| map_sqlx("read_session_checkout", error))?;
        read_registration(&mut connection, registration_id).await
    }

    /// The selected binding is already durable when this guard is returned.
    /// The caller acquires the exact Git claim while holding it. Move this guard
    /// into any blocking claim task so cancelling its async caller cannot release
    /// admission while the Git operation is still running.
    pub async fn admit_session_checkout(
        &self,
        identity: &SessionCheckoutIdentityV1,
    ) -> Result<SessionCheckoutAdmission, DomainStoreErrorV1> {
        let mut transaction = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(|error| map_sqlx("admit_session_checkout", error))?;
        let owner = read(&mut transaction, identity)
            .await?
            .ok_or_else(|| storage("session_checkout_unprepared", "binding is not durable"))?;
        if owner.admission() != SessionCheckoutAdmissionV1::Open {
            return Err(storage(
                "session_checkout_closing",
                "checkout claim admission has been closed by this product operation",
            ));
        }
        Ok(SessionCheckoutAdmission {
            transaction,
            agent_origin: None,
            retained: false,
            binding: owner
                .into_binding()
                .expect("open admission always owns a selected binding")
                .binding,
        })
    }

    /// Close this product's claim writer before runtime retirement, including
    /// legacy owners with no binding. Their closed admission records no cwd or
    /// claim and never substitutes for the runtime's own retirement proof.
    pub async fn begin_session_checkout_close(
        &self,
        identity: &SessionCheckoutIdentityV1,
    ) -> Result<Option<SessionCheckoutRecordV1>, DomainStoreErrorV1> {
        self.transition_session_checkout(identity, None, None, CloseTransition::Begin)
            .await
    }

    /// Compensation closes only the exact resource its operation acquired.
    /// A replacement may own a transferred claim whose retention outlives its
    /// failed create; that claim still belongs to the recovery or explicit close.
    /// Selection and close admission are one transaction, never a read-then-close.
    pub async fn begin_session_checkout_claim_close(
        &self,
        identity: &SessionCheckoutIdentityV1,
        claim_id: &OperationIdV1,
    ) -> Result<Option<SessionCheckoutRecordV1>, DomainStoreErrorV1> {
        self.transition_session_checkout(identity, Some(claim_id), None, CloseTransition::Begin)
            .await
    }

    /// Call only after the runtime chain is retired and this exact Git claim is
    /// released. A crash before this checkpoint leaves Closing for forward cleanup.
    pub async fn finish_session_checkout_close(
        &self,
        identity: &SessionCheckoutIdentityV1,
    ) -> Result<Option<SessionCheckoutRecordV1>, DomainStoreErrorV1> {
        self.transition_session_checkout(identity, None, None, CloseTransition::Finish)
            .await
    }

    async fn transition_session_checkout(
        &self,
        identity: &SessionCheckoutIdentityV1,
        claim_id: Option<&OperationIdV1>,
        close_payload: Option<&serde_json::Value>,
        transition: CloseTransition,
    ) -> Result<Option<SessionCheckoutRecordV1>, DomainStoreErrorV1> {
        let mut transaction = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(|error| map_sqlx("close_session_checkout", error))?;
        let record = transition_on(
            &mut transaction,
            identity,
            claim_id,
            close_payload,
            transition,
        )
        .await?;
        transaction
            .commit()
            .await
            .map_err(|error| map_sqlx("close_session_checkout", error))?;
        Ok(record)
    }
}

pub(crate) async fn transition_on(
    connection: &mut sqlx::SqliteConnection,
    identity: &SessionCheckoutIdentityV1,
    claim_id: Option<&OperationIdV1>,
    close_payload: Option<&serde_json::Value>,
    transition: CloseTransition,
) -> Result<Option<SessionCheckoutRecordV1>, DomainStoreErrorV1> {
    let owner = read(connection, identity).await?;
    if claim_id.is_some_and(|claim_id| {
        !matches!(&owner, Some(OwnerRecord::Bound(record)) if record.binding.claim_id == *claim_id)
    }) || (owner.is_none() && transition != CloseTransition::Begin)
    {
        return Ok(None);
    }
    let mut owner = owner.unwrap_or(OwnerRecord::Closing);
    let payload = if let (Some(payload), OwnerRecord::Bound(record)) = (close_payload, &mut owner) {
        if record
            .close_payload
            .as_ref()
            .is_some_and(|existing| existing != payload)
        {
            return Err(identity_conflict(
                "session_checkout_close",
                identity.owner_id().as_str(),
                "the close already selected another runtime target",
            ));
        }
        record.close_payload = Some(payload.clone());
        Some(
            serde_json::to_string(payload)
                .map_err(|error| serialization("session_checkout_close", error))?,
        )
    } else {
        None
    };
    use SessionCheckoutAdmissionV1::{Closed, Closing, Open};
    let next = match (owner.admission(), transition) {
        (admission, CloseTransition::RememberTarget) => admission,
        (Open, CloseTransition::Begin) => Closing,
        (Open, CloseTransition::Finish) => {
            return Err(storage(
                "session_checkout_admission_open",
                "close admission before retiring its resources",
            ));
        }
        (Closing, CloseTransition::Finish) | (Closed, _) => Closed,
        (Closing, CloseTransition::Begin) => Closing,
    };
    let value = match next {
        Closing => "closing",
        Closed => "closed",
        Open => "open",
    };
    if transition == CloseTransition::RememberTarget {
        // Saving cleanup input neither selects a resource nor changes its
        // admission. A transferred or early-closed owner stays unbound.
        sqlx::query(
            "UPDATE session_checkout_bindings SET close_payload_json = \
                 COALESCE(close_payload_json, ?2) WHERE owner_id = ?1",
        )
        .bind(identity.owner_id().as_str())
        .bind(payload)
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx("remember_session_checkout_close", error))?;
    } else {
        // Close and first selection share the same owner row. An unbound
        // runtime gains only closed admission, never an invented resource.
        sqlx::query(
            "INSERT INTO session_checkout_bindings (owner_id, admission, close_payload_json) VALUES (?1, ?2, ?3) \
             ON CONFLICT (owner_id) DO UPDATE SET admission = excluded.admission, \
             close_payload_json = COALESCE(session_checkout_bindings.close_payload_json, excluded.close_payload_json)",
        )
        .bind(identity.owner_id().as_str())
        .bind(value)
        .bind(payload)
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx("close_session_checkout", error))?;
    }
    Ok(owner.into_binding().map(|mut record| {
        record.admission = next;
        record
    }))
}
