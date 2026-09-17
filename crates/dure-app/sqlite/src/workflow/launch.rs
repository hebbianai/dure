use super::*;
use crate::error::serialization;
use dure_app::WorkflowSessionLaunchRequestV1;

pub(crate) const ADD_PREPARED_LAUNCH: &str =
    "ALTER TABLE workflow_dispatch_launches ADD COLUMN prepared_launch_json TEXT";

pub(crate) async fn prepare(
    pool: &SqlitePool,
    request: &DelegateOnceRequestV1,
    launch: &WorkflowSessionLaunchRequestV1,
) -> Result<WorkflowSessionLaunchRequestV1, DomainStoreErrorV1> {
    let prepared = prepare_delegate_once(request)?;
    launch.validate()?;
    if launch.launch_idempotency_key != prepared.receipt.launch_idempotency_key
        || launch.session_id != workflow_prepared_session_id(&prepared.receipt.dispatch_id)?
        || launch.provider_id != request.provider_id
        || launch.runtime_kind_id != request.runtime_kind_id
    {
        return Err(DomainStoreErrorV1::IdentityConflict {
            entity: "workflow_launch",
            id: request.idempotency_key.clone(),
            reason: "prepared launch must identify the requested delegate".into(),
        });
    }
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("prepare_delegate_once_launch", error))?;
    begin_immediate(&mut connection, "prepare_delegate_once_launch").await?;
    let result = async {
        if request_digest_on(&mut connection, &request.idempotency_key).await?
            != Some(prepared.request_digest)
        {
            return Err(DomainStoreErrorV1::IdempotencyConflict {
                reason: "prepared launch requires the original persisted delegate request".into(),
            });
        }
        if let Some(retained) = read_on(&mut connection, &request.idempotency_key).await? {
            return Ok(retained);
        }
        let encoded = serde_json::to_string(launch)
            .map_err(|error| serialization("delegate_once_launch", error))?;
        let updated = sqlx::query(
            "UPDATE workflow_dispatch_launches SET prepared_launch_json = ?1
             WHERE dispatch_id = ?2 AND state = 'starting' AND prepared_launch_json IS NULL",
        )
        .bind(encoded)
        .bind(prepared.receipt.dispatch_id.as_str())
        .execute(&mut *connection)
        .await
        .map_err(|error| map_sqlx("prepare_delegate_once_launch", error))?;
        if updated.rows_affected() != 1 {
            return Err(corrupt_link(
                "only a pending delegate can prepare its first launch",
            ));
        }
        Ok(launch.clone())
    }
    .await;
    finish_transaction(&mut connection, "prepare_delegate_once_launch", result).await
}

pub(crate) async fn read(
    pool: &SqlitePool,
    idempotency_key: &str,
) -> Result<Option<WorkflowSessionLaunchRequestV1>, DomainStoreErrorV1> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| map_sqlx("read_delegate_once_launch", error))?;
    read_on(&mut connection, idempotency_key).await
}

async fn read_on(
    connection: &mut SqliteConnection,
    idempotency_key: &str,
) -> Result<Option<WorkflowSessionLaunchRequestV1>, DomainStoreErrorV1> {
    let encoded: Option<String> = sqlx::query_scalar(
        "SELECT launch.prepared_launch_json FROM workflow_dispatch_launches launch
         JOIN workflow_delegate_once_receipts receipt USING (dispatch_id)
         WHERE receipt.idempotency_key = ?1",
    )
    .bind(idempotency_key)
    .fetch_optional(&mut *connection)
    .await
    .map_err(|error| map_sqlx("read_delegate_once_launch", error))?
    .flatten();
    encoded
        .map(|encoded| {
            let launch: WorkflowSessionLaunchRequestV1 = serde_json::from_str(&encoded)
                .map_err(|error| serialization("delegate_once_launch", error))?;
            launch.validate()?;
            Ok(launch)
        })
        .transpose()
}
