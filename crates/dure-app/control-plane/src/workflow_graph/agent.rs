use std::collections::BTreeMap;

use agent_orchestration::domain::graph::{
    ActionState, ActionTask, ActionValues, ExecutingWorkflow,
};
use dure_app::{
    AgentSpawnJournalReceiptV1, AgentSpawnJournalStateV1, AgentSpawnJournalStore,
    AgentSpawnPermissionModeV1, AgentSpawnPromptDigestV1, OperationIdV1,
    ProviderLaunchPermissionOverrideV1,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::command::ActionFailure;
use crate::{BackendRequestAuthority, ServiceState};

pub(super) async fn execute(
    state: &ServiceState,
    execution: &mut ExecutingWorkflow,
    task: &ActionTask,
) -> Result<Option<ActionValues>, ActionFailure> {
    let ActionState::Started {
        inputs,
        effect_ref,
        started_at_ms,
        ..
    } = &task.state
    else {
        return Err(failure("agent_dispatch_invalid", false));
    };
    if let Some(report) = state
        .store
        .workflow_action_report(task.dispatch_id.as_str())
        .await
        .map_err(|_| failure("agent_report_unavailable", true))?
    {
        if report.completed {
            return report
                .result_markdown
                .map(|result| Some(BTreeMap::from([("resultMarkdown".into(), json!(result))])))
                .ok_or(failure("agent_report_missing", false));
        }
    }
    let now = crate::now_ms().map_err(|_| failure("workflow_clock_unavailable", true))?;
    let timeout = inputs
        .get("timeoutSeconds")
        .and_then(Value::as_u64)
        .unwrap_or(3600);
    if now.saturating_sub(*started_at_ms) > (timeout * 1000) as i64 {
        return Err(failure("agent_report_timed_out", true));
    }
    let text = |field: &str| {
        inputs
            .get(field)
            .and_then(Value::as_str)
            .unwrap_or_default()
    };
    let mut prompt = text("prompt").to_owned();
    if let Some(input) = inputs.get("input").and_then(Value::as_str) {
        prompt.push_str("\n\nWorkflow input (data from the preceding step):\n");
        prompt.push_str(input);
    }
    if prompt.trim().is_empty() || prompt.len() > 16384 {
        return Err(failure("agent_prompt_invalid", false));
    }
    let authority = BackendRequestAuthority {
        backend_id: state.descriptor.backend_id.clone(),
        generation: state.descriptor.generation.clone(),
    };
    let receipt = if let Some(operation_id) = effect_ref {
        let operation = OperationIdV1::new(operation_id.clone())
            .map_err(|_| failure("agent_effect_invalid", true))?;
        state
            .store
            .agent_spawn_receipt(&operation)
            .await
            .map_err(|_| failure("agent_effect_unavailable", true))?
            .ok_or(failure("agent_effect_unavailable", true))?
    } else {
        let digest = format!("{:x}", Sha256::digest(task.dispatch_id.as_str()));
        let permission: Option<AgentSpawnPermissionModeV1> = inputs
            .get("permissionMode")
            .cloned()
            .map(serde_json::from_value)
            .transpose()
            .map_err(|_| failure("agent_permission_mode_invalid", false))?;
        let profile = inputs
            .get("executionProfile")
            .cloned()
            .unwrap_or_else(|| json!(crate::default_agent_execution_profile()));
        let preview = crate::preview_agent_spawn(state, &authority, &json!({
            "schemaVersion": 1, "idempotencyKey": task.dispatch_id, "projectId": text("projectId"), "providerId": text("providerId"),
            "agentName": format!("workflow-{}", &digest[..12]), "worktree": {"kind": "dedicated", "branch": format!("automation-{digest}")},
            "executionProfile": profile, "interactionPreference": "native_cli",
            "permissionOverride": permission.as_ref().map(ProviderLaunchPermissionOverrideV1::from_concrete), "promptDigest": AgentSpawnPromptDigestV1::sha256(&prompt),
        })).await.map_err(|_| failure("agent_preview_failed", false))?;
        let receipt = parse_receipt(preview)?;
        let prior = execution.run().clone();
        execution
            .bind_effect(&task.dispatch_id, receipt.operation_id.as_str(), now)
            .map_err(|_| failure("agent_effect_invalid", true))?;
        state
            .store
            .update_workflow_run(&prior, execution)
            .await
            .map_err(|_| failure("agent_effect_binding_failed", true))?;
        receipt
    };
    if receipt.plan.request.idempotency_key != task.dispatch_id.as_str() {
        return Err(failure("agent_effect_invalid", true));
    }
    let receipt = match receipt.state {
        AgentSpawnJournalStateV1::Applying | AgentSpawnJournalStateV1::ReadyToSucceed => {
            let result = crate::apply_agent_spawn(
                state,
                &authority,
                crate::agent_spawn_apply::AgentSpawnApplyBody {
                    schema_version: 1,
                    operation_id: receipt.operation_id,
                    plan_token: receipt.plan.plan_token,
                    expected_last_sequence: receipt.last_sequence,
                    prompt: Some(prompt),
                },
            )
            .await
            .map_err(|_| failure("agent_launch_unavailable", true))?;
            parse_receipt(result)?
        }
        _ => receipt,
    };
    match receipt.state {
        AgentSpawnJournalStateV1::Succeeded => Ok(None),
        AgentSpawnJournalStateV1::Failed | AgentSpawnJournalStateV1::RetryRequired => {
            Err(failure("agent_launch_failed", false))
        }
        _ => Err(failure("agent_launch_uncertain", true)),
    }
}

fn parse_receipt(value: Value) -> Result<AgentSpawnJournalReceiptV1, ActionFailure> {
    serde_json::from_value(
        value
            .get("receipt")
            .cloned()
            .ok_or(failure("agent_effect_invalid", true))?,
    )
    .map_err(|_| failure("agent_effect_invalid", true))
}

fn failure(code: &'static str, uncertain: bool) -> ActionFailure {
    ActionFailure {
        code,
        uncertain,
        outputs: None,
    }
}
