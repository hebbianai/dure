use super::*;

impl WorkflowInteractionStore {
    pub(super) async fn create_durable_run(
        &self,
        request: CreateRunRequest,
        context: DispatchContextReceipt,
        fingerprint: String,
    ) -> Result<CreateRunReceipt, StoreError> {
        let mut connection = self.pool.acquire().await.map_err(|_| unavailable())?;
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *connection)
            .await
            .map_err(|_| unavailable())?;
        let outcome = async {
            let binding = exact_local_binding(&mut connection, &request).await?;
            let mut state = load_state(&mut connection, &request.authority).await?;
            let receipt =
                state.create_run(request.clone(), context.clone(), fingerprint.clone())?;
            if !receipt.idempotent {
                if !crate::agent_runtime_close::is_open_on(&mut connection, &binding.agent_id)
                    .await
                    .map_err(|_| unavailable())?
                {
                    return Err(StoreError::StateConflict {
                        code: "agent_runtime_not_open",
                    });
                }
                ensure_session_is_unassigned(&mut connection, &request).await?;
                insert_canonical_run(&mut connection, &request, &context, &binding, &fingerprint)
                    .await?;
                crate::workflow_effect_bindings::bind(
                    &mut connection,
                    binding.agent_id.as_str(),
                    context.target.dispatch_id.as_str(),
                )
                .await
                .map_err(|_| unavailable())?;
            }
            persist_state(&mut connection, &request.authority, &state).await?;
            Ok(receipt)
        }
        .await;
        finish_store_transaction(&mut connection, outcome).await
    }
}
