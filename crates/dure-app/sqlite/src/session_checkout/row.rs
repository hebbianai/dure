use sqlx::sqlite::SqliteRow;
use sqlx::{Row, SqliteConnection};

use super::*;

/// A runtime can close before it has any product resource to retain. Keep that
/// admission in the same owner row without inventing an open, unbound claim.
pub(crate) enum OwnerRecord {
    Bound(Box<SessionCheckoutRecordV1>),
    Closing,
    Closed,
}

impl OwnerRecord {
    pub(super) fn admission(&self) -> SessionCheckoutAdmissionV1 {
        match self {
            Self::Bound(record) => record.admission,
            Self::Closing => SessionCheckoutAdmissionV1::Closing,
            Self::Closed => SessionCheckoutAdmissionV1::Closed,
        }
    }

    pub(crate) fn into_binding(self) -> Option<SessionCheckoutRecordV1> {
        match self {
            Self::Bound(record) => Some(*record),
            Self::Closing | Self::Closed => None,
        }
    }
}

pub(crate) async fn read(
    connection: &mut SqliteConnection,
    identity: &SessionCheckoutIdentityV1,
) -> Result<Option<OwnerRecord>, DomainStoreErrorV1> {
    let row = sqlx::query(
        "SELECT registration_id, owner_id, binding_json, admission, close_payload_json FROM session_checkout_bindings WHERE owner_id = ?1",
    )
    .bind(identity.owner_id().as_str())
    .fetch_optional(connection)
    .await
    .map_err(|error| map_sqlx("read_session_checkout", error))?;
    decode_row(row)
}

pub(crate) async fn read_registration(
    connection: &mut SqliteConnection,
    registration_id: &OperationIdV1,
) -> Result<Option<SessionCheckoutRecordV1>, DomainStoreErrorV1> {
    let row = sqlx::query(
        "SELECT registration_id, owner_id, binding_json, admission, close_payload_json FROM session_checkout_bindings WHERE registration_id = ?1",
    )
    .bind(registration_id.as_str())
    .fetch_optional(connection)
    .await
    .map_err(|error| map_sqlx("read_session_checkout", error))?;
    Ok(decode_row(row)?.and_then(OwnerRecord::into_binding))
}

pub(crate) fn decode_row(
    row: Option<SqliteRow>,
) -> Result<Option<OwnerRecord>, DomainStoreErrorV1> {
    let Some(row) = row else { return Ok(None) };
    let serialized: Option<String> = row
        .try_get("binding_json")
        .map_err(|error| map_sqlx("read_session_checkout", error))?;
    let registration_id: Option<String> = row
        .try_get("registration_id")
        .map_err(|error| map_sqlx("read_session_checkout", error))?;
    let owner_id: String = row
        .try_get("owner_id")
        .map_err(|error| map_sqlx("read_session_checkout", error))?;
    let admission: String = row
        .try_get("admission")
        .map_err(|error| map_sqlx("read_session_checkout", error))?;
    let admission = match admission.as_str() {
        "open" => SessionCheckoutAdmissionV1::Open,
        "closing" => SessionCheckoutAdmissionV1::Closing,
        "closed" => SessionCheckoutAdmissionV1::Closed,
        _ => {
            return Err(storage(
                "session_checkout_state_invalid",
                "unknown claim admission",
            ));
        }
    };
    let owner = match (serialized, registration_id, admission) {
        (None, None, SessionCheckoutAdmissionV1::Closing) => OwnerRecord::Closing,
        (None, None, SessionCheckoutAdmissionV1::Closed) => OwnerRecord::Closed,
        (Some(serialized), Some(registration_id), admission) => {
            let binding: SessionCheckoutBindingV1 = serde_json::from_str(&serialized)
                .map_err(|error| serialization("session_checkout_binding", error))?;
            if binding.claim_id.as_str() != registration_id
                || binding.identity.owner_id().as_str() != owner_id
            {
                return Err(storage(
                    "session_checkout_identity_changed",
                    "stored identity differs from its key",
                ));
            }
            let payload: Option<String> = row
                .try_get("close_payload_json")
                .map_err(|error| map_sqlx("read_session_checkout", error))?;
            let close_payload = payload
                .map(|payload| {
                    serde_json::from_str(&payload)
                        .map_err(|error| serialization("session_checkout_close", error))
                })
                .transpose()?;
            OwnerRecord::Bound(Box::new(SessionCheckoutRecordV1 {
                binding,
                admission,
                close_payload,
            }))
        }
        _ => {
            return Err(storage(
                "session_checkout_state_invalid",
                "an unbound owner must be closed and cannot name a resource claim",
            ));
        }
    };
    Ok(Some(owner))
}
