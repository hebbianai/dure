use dure_app::DomainStoreErrorV1;
use serde::Serialize;

use super::definitions::db;
use crate::SqliteDomainStore;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowActionReport {
    pub report_dispatch_id: String,
    pub completed: bool,
    pub blocked_by: Option<String>,
    pub result_markdown: Option<String>,
}

impl SqliteDomainStore {
    pub async fn workflow_action_report(
        &self,
        dispatch_id: &str,
    ) -> Result<Option<WorkflowActionReport>, DomainStoreErrorV1> {
        let row: Option<(String, String, Option<String>, Option<String>)> = sqlx::query_as(r#"
            SELECT dispatch.dispatch_id, dispatch.state, authority.blocked_by, dispatch.completion_result
            FROM workflow_action_effects AS effect
            JOIN workflow_dispatches AS dispatch ON dispatch.dispatch_id = effect.report_dispatch_id
            JOIN workflow_interaction_authorities AS authority ON authority.dispatch_id = dispatch.dispatch_id
            WHERE effect.dispatch_id = ?1"#)
            .bind(dispatch_id).fetch_optional(&self.pool).await.map_err(db)?;
        Ok(
            row.map(|(report_dispatch_id, state, blocked_by, result_markdown)| {
                WorkflowActionReport {
                    report_dispatch_id,
                    completed: state == "completed",
                    blocked_by,
                    result_markdown,
                }
            }),
        )
    }
}
