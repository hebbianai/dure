use std::str::FromStr;
use std::sync::Arc;

use chrono::{Datelike, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use dure_app::{
    AGENT_SPAWN_SCHEMA_VERSION_V1, AgentExecutionProfileV1, AgentSpawnEffortSelectionV1,
    AgentSpawnJournalReceiptV1, AgentSpawnJournalStateV1, AgentSpawnModelSelectionV1,
    AgentSpawnPermissionModeV1, AgentSpawnPromptDigestV1, OperationIdV1, ProjectIdV1, ProviderIdV1,
    ProviderLaunchPermissionOverrideV1, SCHEDULE_SCHEMA_VERSION_V1, ScheduleDeleteRequestV1,
    ScheduleIdV1, ScheduleOccurrenceRecordV2, SchedulePutRequestV1, ScheduleRecordV1,
    ScheduleRunTemplateV1, ScheduleWorkspacePolicyV1,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::time::{Duration, MissedTickBehavior};

use crate::{
    BackendDispatchError, BackendRequestAuthority, ServiceState, agent_spawn_apply,
    apply_agent_spawn, now_ms, preview_agent_spawn, projects_catalog, valid_project_id,
    valid_project_path,
};

const MAX_SCHEDULE_ITEMS: usize = 128;
const MAX_OCCURRENCE_ITEMS: usize = 256;
const SCHEDULE_TICK_INTERVAL: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SchedulePutBody {
    schema_version: u16,
    schedule_id: ScheduleIdV1,
    expected_revision: u64,
    idempotency_key: String,
    name: String,
    enabled: bool,
    expression: String,
    timezone: String,
    run_template: IncomingRunTemplate,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IncomingRunTemplate {
    #[serde(default)]
    project_id: Option<ProjectIdV1>,
    #[serde(default)]
    project_path: Option<String>,
    provider_id: ProviderIdV1,
    prompt: String,
    #[serde(default)]
    model: Option<AgentSpawnModelSelectionV1>,
    #[serde(default)]
    effort: Option<AgentSpawnEffortSelectionV1>,
    #[serde(default)]
    permission_mode: Option<AgentSpawnPermissionModeV1>,
    #[serde(default = "crate::default_agent_execution_profile")]
    execution_profile: AgentExecutionProfileV1,
    #[serde(default)]
    worktree: ScheduleWorkspacePolicyV1,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ScheduleListBody {
    schema_version: u16,
    max_items: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ScheduleShowBody {
    schema_version: u16,
    schedule_id: ScheduleIdV1,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ScheduleDeleteBody {
    schema_version: u16,
    schedule_id: ScheduleIdV1,
    expected_revision: u64,
    idempotency_key: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ScheduleOccurrencesBody {
    schema_version: u16,
    #[serde(default)]
    schedule_id: Option<ScheduleIdV1>,
    max_items: usize,
}

pub(crate) async fn invoke(
    state: &ServiceState,
    operation: &str,
    body: &Value,
) -> Result<Value, BackendDispatchError> {
    fn parse<T: serde::de::DeserializeOwned>(body: &Value) -> Result<T, BackendDispatchError> {
        serde_json::from_value(body.clone()).map_err(|_| "schedule_request_invalid".into())
    }
    match operation {
        "schedule.put" => put(state, parse(body)?).await,
        "schedule.list" => list(state, parse(body)?).await,
        "schedule.show" => show(state, parse(body)?).await,
        "schedule.delete" => delete(state, parse(body)?).await,
        "schedule.occurrences" => occurrences(state, parse(body)?).await,
        "schedule.run_once" => run_once(state, parse(body)?).await,
        "schedule.inspect" => inspect(state, parse(body)?).await,
        _ => Err("schedule_request_invalid".into()),
    }
}

pub(crate) async fn put(
    state: &ServiceState,
    body: SchedulePutBody,
) -> Result<Value, BackendDispatchError> {
    validate_expression(&body.expression, &body.timezone)?;
    if body.schema_version != SCHEDULE_SCHEMA_VERSION_V1
        || body.run_template.project_id.is_some() == body.run_template.project_path.is_some()
        || body
            .run_template
            .project_id
            .as_ref()
            .is_some_and(|project_id| !valid_project_id(project_id.as_str()))
        || body
            .run_template
            .project_path
            .as_deref()
            .is_some_and(|path| !valid_project_path(path))
    {
        return Err("schedule_request_invalid".into());
    }
    let catalog = projects_catalog(state)
        .await
        .map_err(BackendDispatchError::from)?;
    let project = body
        .run_template
        .project_path
        .as_deref()
        .map_or_else(
            || {
                body.run_template
                    .project_id
                    .as_ref()
                    .and_then(|project_id| catalog.project(project_id.as_str()))
            },
            |path| catalog.project_for_path(path),
        )
        .ok_or_else(|| BackendDispatchError::from("schedule_project_not_found"))?;
    let request = SchedulePutRequestV1 {
        schema_version: body.schema_version,
        schedule_id: body.schedule_id,
        expected_revision: body.expected_revision,
        idempotency_key: body.idempotency_key,
        name: body.name,
        enabled: body.enabled,
        expression: body.expression,
        timezone: body.timezone,
        run_template: ScheduleRunTemplateV1 {
            project_id: ProjectIdV1::new(project.projection().id.clone())
                .map_err(|_| BackendDispatchError::from("schedule_request_invalid"))?,
            provider_id: body.run_template.provider_id,
            prompt: body.run_template.prompt,
            model: body.run_template.model,
            effort: body.run_template.effort,
            permission_mode: body.run_template.permission_mode,
            execution_profile: body.run_template.execution_profile,
            worktree: body.run_template.worktree,
        },
    };
    let observed_at_ms =
        now_ms().map_err(|_| BackendDispatchError::from("schedule_clock_unavailable"))?;
    let schedule = state
        .store
        .put_schedule(&request, observed_at_ms)
        .await
        .map_err(schedule_store_error)?;
    Ok(json!({ "schemaVersion": 1, "schedule": schedule }))
}

pub(crate) async fn list(
    state: &ServiceState,
    body: ScheduleListBody,
) -> Result<Value, BackendDispatchError> {
    if body.schema_version != SCHEDULE_SCHEMA_VERSION_V1
        || !(1..=MAX_SCHEDULE_ITEMS).contains(&body.max_items)
    {
        return Err("schedule_request_invalid".into());
    }
    let (schedules, complete) = state
        .store
        .schedules(body.max_items)
        .await
        .map_err(schedule_store_error)?;
    Ok(json!({
        "schemaVersion": 1,
        "complete": complete,
        "schedules": schedules,
    }))
}

pub(crate) async fn show(
    state: &ServiceState,
    body: ScheduleShowBody,
) -> Result<Value, BackendDispatchError> {
    if body.schema_version != SCHEDULE_SCHEMA_VERSION_V1 {
        return Err("schedule_request_invalid".into());
    }
    let schedule = state
        .store
        .schedule(&body.schedule_id)
        .await
        .map_err(schedule_store_error)?
        .ok_or_else(|| BackendDispatchError::from("schedule_not_found"))?;
    Ok(json!({ "schemaVersion": 1, "schedule": schedule }))
}

pub(crate) async fn delete(
    state: &ServiceState,
    body: ScheduleDeleteBody,
) -> Result<Value, BackendDispatchError> {
    let observed_at_ms =
        now_ms().map_err(|_| BackendDispatchError::from("schedule_clock_unavailable"))?;
    let schedule = state
        .store
        .delete_schedule(
            &ScheduleDeleteRequestV1 {
                schema_version: body.schema_version,
                schedule_id: body.schedule_id,
                expected_revision: body.expected_revision,
                idempotency_key: body.idempotency_key,
            },
            observed_at_ms,
        )
        .await
        .map_err(schedule_store_error)?;
    Ok(json!({ "schemaVersion": 1, "schedule": schedule }))
}

pub(crate) async fn occurrences(
    state: &ServiceState,
    body: ScheduleOccurrencesBody,
) -> Result<Value, BackendDispatchError> {
    if body.schema_version != SCHEDULE_SCHEMA_VERSION_V1
        || !(1..=MAX_OCCURRENCE_ITEMS).contains(&body.max_items)
    {
        return Err("schedule_request_invalid".into());
    }
    let occurrences = state
        .store
        .schedule_occurrences(body.schedule_id.as_ref(), body.max_items)
        .await
        .map_err(schedule_store_error)?;
    Ok(json!({ "schemaVersion": 1, "occurrences": occurrences }))
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ScheduleRunOnceBody {
    schema_version: u16,
    schedule_id: ScheduleIdV1,
    expected_revision: u64,
    idempotency_key: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ScheduleInspectBody {
    schema_version: u16,
    idempotency_key: String,
}

pub(crate) async fn run_once(
    state: &ServiceState,
    body: ScheduleRunOnceBody,
) -> Result<Value, BackendDispatchError> {
    if body.schema_version != 1 {
        return Err("schedule_request_invalid".into());
    }
    let observed_at_ms =
        now_ms().map_err(|_| BackendDispatchError::from("schedule_clock_unavailable"))?;
    let occurrence = state
        .store
        .run_schedule_once(
            &body.schedule_id,
            body.expected_revision,
            &body.idempotency_key,
            observed_at_ms,
        )
        .await
        .map_err(schedule_store_error)?;
    Ok(json!({ "schemaVersion": 1, "occurrence": occurrence }))
}

pub(crate) async fn inspect(
    state: &ServiceState,
    body: ScheduleInspectBody,
) -> Result<Value, BackendDispatchError> {
    if body.schema_version != 1
        || body.idempotency_key.is_empty()
        || body.idempotency_key.len() > 160
    {
        return Err("schedule_request_invalid".into());
    }
    let (occurrence, result_markdown) = state
        .store
        .schedule_occurrence(&body.idempotency_key)
        .await
        .map_err(schedule_store_error)?
        .ok_or_else(|| BackendDispatchError::from("schedule_occurrence_not_found"))?;
    Ok(json!({ "schemaVersion": 1, "occurrence": occurrence, "resultMarkdown": result_markdown }))
}

pub(crate) async fn run_loop(state: Arc<ServiceState>) {
    let mut interval = tokio::time::interval(SCHEDULE_TICK_INTERVAL);
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        if !state.is_mutation_authority() {
            continue;
        }
        let observed_at_ms = match now_ms() {
            Ok(value) => value,
            Err(_) => continue,
        };
        let _ = tick(&state, observed_at_ms).await;
    }
}

pub(crate) async fn tick(
    state: &ServiceState,
    observed_at_ms: i64,
) -> Result<(), BackendDispatchError> {
    let pending = state
        .store
        .pending_schedule_occurrences(MAX_OCCURRENCE_ITEMS)
        .await
        .map_err(schedule_store_error)?;
    for (occurrence, template) in pending {
        execute_occurrence(state, occurrence, template, observed_at_ms).await;
    }

    let minute_ms = observed_at_ms - observed_at_ms.rem_euclid(60_000);
    let (schedules, _) = state
        .store
        .schedules(MAX_SCHEDULE_ITEMS)
        .await
        .map_err(schedule_store_error)?;
    for schedule in schedules {
        if !schedule.enabled || !is_due(&schedule, minute_ms)? {
            continue;
        }
        let idempotency_key = occurrence_idempotency_key(&schedule.schedule_id, minute_ms);
        let Some((occurrence, template)) = state
            .store
            .claim_schedule_occurrence(
                &schedule.schedule_id,
                schedule.revision,
                minute_ms,
                &idempotency_key,
                observed_at_ms,
            )
            .await
            .map_err(schedule_store_error)?
        else {
            continue;
        };
        execute_occurrence(state, occurrence, template, observed_at_ms).await;
    }
    Ok(())
}

pub(super) async fn execute_occurrence(
    state: &ServiceState,
    occurrence: ScheduleOccurrenceRecordV2,
    template: ScheduleRunTemplateV1,
    observed_at_ms: i64,
) {
    let authority = BackendRequestAuthority {
        backend_id: state.descriptor.backend_id.clone(),
        generation: state.descriptor.generation.clone(),
    };
    let digest = Sha256::digest(occurrence.idempotency_key.as_bytes());
    let agent_name = format!("scheduled-{digest:x}");
    let permission_override = template
        .permission_mode
        .as_ref()
        .map(ProviderLaunchPermissionOverrideV1::from_concrete);
    let ScheduleWorkspacePolicyV1::Dedicated { base_commit_sha } = &template.worktree;
    let mut worktree = json!({ "kind": "dedicated", "branch": format!("automation-{digest:x}") });
    if let Some(sha) = base_commit_sha {
        worktree["baseCommitSha"] = json!(sha);
    }
    let preview_body = json!({
        "schemaVersion": AGENT_SPAWN_SCHEMA_VERSION_V1,
        "idempotencyKey": occurrence.idempotency_key,
        "projectId": template.project_id,
        "providerId": template.provider_id,
        "model": template.model,
        "effort": template.effort,
        "agentName": &agent_name[..22],
        "worktree": worktree,
        "executionProfile": template.execution_profile,
        "interactionPreference": "native_cli",
        "permissionOverride": permission_override,
        "promptDigest": AgentSpawnPromptDigestV1::sha256(&template.prompt),
    });
    let outcome = spawn_occurrence(state, authority, preview_body, template.prompt).await;

    let completed_at_ms = now_ms().unwrap_or(observed_at_ms);
    let completion = match outcome {
        Ok(operation_id) => {
            state
                .store
                .finish_schedule_launch(
                    &occurrence.idempotency_key,
                    Some(operation_id.as_str()),
                    None,
                    completed_at_ms,
                )
                .await
        }
        Err((operation_id, code)) => {
            let code = bounded_error_code(&code);
            state
                .store
                .finish_schedule_launch(
                    &occurrence.idempotency_key,
                    operation_id.as_ref().map(OperationIdV1::as_str),
                    Some(&code),
                    completed_at_ms,
                )
                .await
        }
    };
    let _ = completion;
}

async fn spawn_occurrence(
    state: &ServiceState,
    authority: BackendRequestAuthority,
    preview_body: Value,
    prompt: String,
) -> Result<OperationIdV1, (Option<OperationIdV1>, String)> {
    let preview = preview_agent_spawn(state, &authority, &preview_body)
        .await
        .map_err(|error| (None, error))?;
    let receipt: AgentSpawnJournalReceiptV1 = serde_json::from_value(
        preview
            .get("receipt")
            .cloned()
            .ok_or_else(|| (None, "schedule_run_receipt_invalid".to_string()))?,
    )
    .map_err(|_| (None, "schedule_run_receipt_invalid".to_string()))?;
    let operation_id = receipt.operation_id.clone();
    state
        .store
        .bind_schedule_spawn(&receipt.plan.request.idempotency_key, operation_id.as_str())
        .await
        .map_err(|_| {
            (
                Some(operation_id.clone()),
                "schedule_spawn_binding_failed".into(),
            )
        })?;
    let applied = apply_agent_spawn(
        state,
        &authority,
        agent_spawn_apply::AgentSpawnApplyBody {
            schema_version: AGENT_SPAWN_SCHEMA_VERSION_V1,
            operation_id: operation_id.clone(),
            plan_token: receipt.plan.plan_token,
            expected_last_sequence: receipt.last_sequence,
            prompt: Some(prompt),
        },
    )
    .await
    .map_err(|error| (Some(operation_id.clone()), error.code))?;
    let receipt: AgentSpawnJournalReceiptV1 =
        serde_json::from_value(applied.get("receipt").cloned().ok_or_else(|| {
            (
                Some(operation_id.clone()),
                "schedule_run_receipt_invalid".to_string(),
            )
        })?)
        .map_err(|_| {
            (
                Some(operation_id.clone()),
                "schedule_run_receipt_invalid".to_string(),
            )
        })?;
    if receipt.state != AgentSpawnJournalStateV1::Succeeded {
        return Err((
            Some(operation_id),
            receipt
                .terminal_code
                .unwrap_or_else(|| "schedule_run_incomplete".into()),
        ));
    }
    Ok(operation_id)
}

fn bounded_error_code(value: &str) -> String {
    let candidate = value.split(':').next().unwrap_or_default();
    if !candidate.is_empty()
        && candidate.len() <= 160
        && candidate
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        candidate.into()
    } else {
        "schedule_run_failed".into()
    }
}

fn occurrence_idempotency_key(schedule_id: &ScheduleIdV1, scheduled_for_ms: i64) -> String {
    let digest = Sha256::digest(format!("{schedule_id}:{scheduled_for_ms}").as_bytes());
    format!("schedule-run-{digest:x}")
}

fn is_due(schedule: &ScheduleRecordV1, minute_ms: i64) -> Result<bool, BackendDispatchError> {
    expression_is_due(&schedule.expression, &schedule.timezone, minute_ms)
}

pub(crate) fn expression_is_due(
    expression: &str,
    timezone: &str,
    minute_ms: i64,
) -> Result<bool, BackendDispatchError> {
    let fields = parse_expression(expression)?;
    let timezone = Tz::from_str(timezone)
        .map_err(|_| BackendDispatchError::from("schedule_timezone_invalid"))?;
    let instant = Utc
        .timestamp_millis_opt(minute_ms)
        .single()
        .ok_or_else(|| BackendDispatchError::from("schedule_time_invalid"))?
        .with_timezone(&timezone);
    let day_of_week = instant.weekday().num_days_from_sunday();
    Ok(fields[0].matches(instant.minute())
        && fields[1].matches(instant.hour())
        && fields[2].matches(instant.day())
        && fields[3].matches(instant.month())
        && (fields[4].matches(day_of_week) || (day_of_week == 0 && fields[4].matches(7))))
}

pub(crate) fn validate_expression(
    expression: &str,
    timezone: &str,
) -> Result<(), BackendDispatchError> {
    parse_expression(expression)?;
    Tz::from_str(timezone).map_err(|_| BackendDispatchError::from("schedule_timezone_invalid"))?;
    Ok(())
}

fn parse_expression(expression: &str) -> Result<[CronField; 5], BackendDispatchError> {
    let parts = expression.split_whitespace().collect::<Vec<_>>();
    if parts.len() != 5 {
        return Err("schedule_expression_invalid".into());
    }
    Ok([
        CronField::parse(parts[0], 0, 59)?,
        CronField::parse(parts[1], 0, 23)?,
        CronField::parse(parts[2], 1, 31)?,
        CronField::parse(parts[3], 1, 12)?,
        CronField::parse(parts[4], 0, 7)?,
    ])
}

#[derive(Clone, Debug)]
struct CronField {
    minimum: u32,
    values: Vec<bool>,
}

impl CronField {
    fn parse(source: &str, minimum: u32, maximum: u32) -> Result<Self, BackendDispatchError> {
        if source.is_empty() || source.len() > 128 {
            return Err("schedule_expression_invalid".into());
        }
        let mut values = vec![false; usize::try_from(maximum - minimum + 1).unwrap_or(0)];
        for part in source.split(',') {
            let (range, step) = part.split_once('/').map_or((part, 1), |(range, step)| {
                (range, step.parse::<u32>().unwrap_or(0))
            });
            if step == 0 {
                return Err("schedule_expression_invalid".into());
            }
            let (start, end) = if range == "*" {
                (minimum, maximum)
            } else if let Some((start, end)) = range.split_once('-') {
                (
                    start
                        .parse::<u32>()
                        .map_err(|_| BackendDispatchError::from("schedule_expression_invalid"))?,
                    end.parse::<u32>()
                        .map_err(|_| BackendDispatchError::from("schedule_expression_invalid"))?,
                )
            } else {
                let value = range
                    .parse::<u32>()
                    .map_err(|_| BackendDispatchError::from("schedule_expression_invalid"))?;
                (value, value)
            };
            if start < minimum || end > maximum || start > end {
                return Err("schedule_expression_invalid".into());
            }
            for value in start..=end {
                if (value - start) % step == 0 {
                    values[usize::try_from(value - minimum).unwrap_or(0)] = true;
                }
            }
        }
        if !values.iter().any(|value| *value) {
            return Err("schedule_expression_invalid".into());
        }
        Ok(Self { minimum, values })
    }

    fn matches(&self, value: u32) -> bool {
        value
            .checked_sub(self.minimum)
            .and_then(|index| usize::try_from(index).ok())
            .and_then(|index| self.values.get(index))
            .copied()
            .unwrap_or(false)
    }
}

fn schedule_store_error(error: dure_app::DomainStoreErrorV1) -> BackendDispatchError {
    let code = match error {
        dure_app::DomainStoreErrorV1::InvalidRecord { .. } => "schedule_request_invalid",
        dure_app::DomainStoreErrorV1::NotFound { .. } => "schedule_not_found",
        dure_app::DomainStoreErrorV1::IdempotencyConflict { .. } => "schedule_idempotency_conflict",
        dure_app::DomainStoreErrorV1::IdentityConflict { reason, .. }
            if reason.starts_with("schedule_revision_conflict") =>
        {
            "schedule_revision_conflict"
        }
        dure_app::DomainStoreErrorV1::IdentityConflict { .. } => "schedule_identity_conflict",
        _ => "schedule_store_unavailable",
    };
    BackendDispatchError::from(code)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schedule(expression: &str, timezone: &str) -> ScheduleRecordV1 {
        ScheduleRecordV1 {
            schema_version: 1,
            schedule_id: ScheduleIdV1::new("morning").unwrap(),
            revision: 1,
            name: "Morning".into(),
            enabled: true,
            expression: expression.into(),
            timezone: timezone.into(),
            run_template: ScheduleRunTemplateV1 {
                project_id: ProjectIdV1::new("dure").unwrap(),
                provider_id: ProviderIdV1::new("codex").unwrap(),
                prompt: "triage".into(),
                model: None,
                effort: None,
                permission_mode: Some(AgentSpawnPermissionModeV1::Default),
                execution_profile: AgentExecutionProfileV1::ProviderDefault,
                worktree: ScheduleWorkspacePolicyV1::default(),
            },
            created_at_ms: 1,
            updated_at_ms: 1,
            deleted_at_ms: None,
        }
    }

    #[test]
    fn matches_the_same_instant_in_the_selected_timezone() {
        let instant = Utc.with_ymd_and_hms(2026, 8, 17, 0, 0, 0).unwrap();
        assert!(
            is_due(
                &schedule("0 9 * * 1-5", "Asia/Seoul"),
                instant.timestamp_millis()
            )
            .unwrap()
        );
        assert!(!is_due(&schedule("0 9 * * 1-5", "UTC"), instant.timestamp_millis()).unwrap());
    }

    #[test]
    fn rejects_invalid_cron_fields_and_timezones() {
        assert!(parse_expression("0 25 * * *").is_err());
        assert!(validate_expression("0 9 * * 1-5", "local").is_err());
    }
}
