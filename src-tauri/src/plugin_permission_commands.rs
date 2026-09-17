use std::path::Path;

use dure_app::{
    compare_plugin_permission_plan_digest, diff_plugin_permission_review_projections, PluginIdV2,
    PluginPermissionDecisionRequestIdV2, PluginPermissionDecisionStateV2,
    PluginPermissionDecisionV2, PluginPermissionEnablementV2, PluginPermissionPlanComparisonV2,
    PluginPermissionPlanDigestV2, PluginPermissionPlanV2, PluginPermissionReviewDiffV2,
    PluginPermissionReviewProjectionV2,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::plugin_issue_tracker::DureIssueTrackerState;
use crate::plugin_permissions::{
    DurePluginPermissionState, PluginPermissionDecisionCas, PluginPermissionDisablePersistence,
    PluginPermissionRetirementOutcome, PluginPermissionStoreError, ResolvedPluginPermissionTarget,
};

pub(crate) const PLUGIN_PERMISSION_EVENT: &str = "dure://plugin/permission";
const MAX_WORKSPACE_ROOT_BYTES: usize = 4_096;

#[derive(Debug)]
pub(crate) struct DurePluginPermissionRuntime {
    state: Result<DurePluginPermissionState, PluginPermissionStoreError>,
}

impl Default for DurePluginPermissionRuntime {
    fn default() -> Self {
        Self {
            state: DurePluginPermissionState::open_default(),
        }
    }
}

impl DurePluginPermissionRuntime {
    pub(crate) fn available(&self) -> Result<&DurePluginPermissionState, String> {
        self.state.as_ref().map_err(ToString::to_string)
    }

    pub(crate) fn resolve_current(
        &self,
        plugin_id: &str,
        workspace_root: &str,
    ) -> Result<(ResolvedPluginPermissionTarget, PluginPermissionPlanV2), String> {
        validate_workspace_root(workspace_root)?;
        let plugin_id = PluginIdV2::new(plugin_id.to_owned()).map_err(|error| error.to_string())?;
        let state = self.available()?;
        let target = state
            .resolve_target(Path::new(workspace_root), &plugin_id)
            .map_err(|error| error.to_string())?;
        let plan = crate::plugin_catalog::bundled_permission_plan(
            &plugin_id,
            target.workspace().identity().clone(),
        )?;
        Ok((target, plan))
    }
}

fn validate_workspace_root(workspace_root: &str) -> Result<(), String> {
    if workspace_root.is_empty()
        || workspace_root.len() > MAX_WORKSPACE_ROOT_BYTES
        || workspace_root.trim() != workspace_root
        || workspace_root.chars().any(char::is_control)
    {
        return Err("plugin_permission_workspace_invalid".to_owned());
    }
    Ok(())
}

#[derive(Debug)]
struct PermissionCommandError(String);

impl From<PluginPermissionStoreError> for PermissionCommandError {
    fn from(error: PluginPermissionStoreError) -> Self {
        Self(error.to_string())
    }
}

impl From<String> for PermissionCommandError {
    fn from(error: String) -> Self {
        Self(error)
    }
}

impl std::fmt::Display for PermissionCommandError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DurePluginPermissionTargetRequest {
    plugin_id: String,
    workspace_root: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DurePluginPermissionDecisionRequest {
    plugin_id: String,
    workspace_root: String,
    request_id: String,
    expected_record_revision: String,
    expected_plan_digest: String,
    decision: PluginPermissionDecisionV2,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DurePluginPermissionEnableRequest {
    plugin_id: String,
    workspace_root: String,
    request_id: String,
    expected_record_revision: String,
    expected_plan_digest: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DurePluginPermissionDisableRequest {
    plugin_id: String,
    workspace_root: String,
    request_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum DurePluginPermissionReviewComparison {
    NoReviewedPlan,
    MatchesReviewedProjection {
        reviewed_plan_digest: PluginPermissionPlanDigestV2,
    },
    ChangedSinceReview {
        reviewed_plan_digest: PluginPermissionPlanDigestV2,
        diff: PluginPermissionReviewDiffV2,
    },
    LegacyDigestOnly {
        reviewed_plan_digest: PluginPermissionPlanDigestV2,
    },
}

#[derive(Clone, Debug, Serialize)]
struct DurePluginPermissionReviewSnapshot {
    current: PluginPermissionReviewProjectionV2,
    comparison: DurePluginPermissionReviewComparison,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct DurePluginPermissionSnapshot {
    plan: PluginPermissionPlanV2,
    review: DurePluginPermissionReviewSnapshot,
    record_revision: String,
    decision_revision: String,
    enablement_epoch: String,
    decision: Option<PluginPermissionDecisionV2>,
    reviewed_plan_digest: Option<PluginPermissionPlanDigestV2>,
    plan_comparison: PluginPermissionPlanComparisonV2,
    enabled: bool,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum DurePluginPermissionRuntimeRetirement {
    Succeeded,
    Failed,
}

#[derive(Debug, Serialize)]
pub(crate) struct DurePluginPermissionDisableReceipt {
    #[serde(flatten)]
    snapshot: DurePluginPermissionSnapshot,
    disable_request_persistence: PluginPermissionDisablePersistence,
    runtime_retirement: DurePluginPermissionRuntimeRetirement,
}

fn parse_revision(value: &str) -> Result<u64, String> {
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err("plugin_permission_revision_invalid".to_owned());
    }
    value
        .parse::<u64>()
        .map_err(|_| "plugin_permission_revision_invalid".to_owned())
}

fn parse_request_id(value: String) -> Result<PluginPermissionDecisionRequestIdV2, String> {
    PluginPermissionDecisionRequestIdV2::new(value).map_err(|error| error.to_string())
}

fn parse_plan_digest(value: String) -> Result<PluginPermissionPlanDigestV2, String> {
    PluginPermissionPlanDigestV2::new(value).map_err(|error| error.to_string())
}

fn permission_snapshot(
    state: PluginPermissionDecisionStateV2,
    plan: PluginPermissionPlanV2,
) -> DurePluginPermissionSnapshot {
    let reviewed_plan_digest = state
        .decision_binding()
        .map(|binding| binding.plan_digest().clone());
    let plan_comparison =
        compare_plugin_permission_plan_digest(&plan, reviewed_plan_digest.as_ref());
    let enabled = state.enablement() == PluginPermissionEnablementV2::Enabled
        && state.decision() == Some(PluginPermissionDecisionV2::Approve)
        && plan_comparison == PluginPermissionPlanComparisonV2::MatchesReviewedPlan;
    let review_comparison = match state.decision_binding() {
        None => DurePluginPermissionReviewComparison::NoReviewedPlan,
        Some(binding) => match state.reviewed_projection() {
            None => DurePluginPermissionReviewComparison::LegacyDigestOnly {
                reviewed_plan_digest: binding.plan_digest().clone(),
            },
            Some(reviewed)
                if binding.plan_digest() == plan.digest()
                    && reviewed == plan.review_projection() =>
            {
                DurePluginPermissionReviewComparison::MatchesReviewedProjection {
                    reviewed_plan_digest: binding.plan_digest().clone(),
                }
            }
            Some(reviewed) => DurePluginPermissionReviewComparison::ChangedSinceReview {
                reviewed_plan_digest: binding.plan_digest().clone(),
                diff: diff_plugin_permission_review_projections(
                    reviewed,
                    plan.review_projection(),
                ),
            },
        },
    };
    let review = DurePluginPermissionReviewSnapshot {
        current: plan.review_projection().clone(),
        comparison: review_comparison,
    };
    DurePluginPermissionSnapshot {
        plan,
        review,
        record_revision: state.record_revision().to_string(),
        decision_revision: state.decision_revision().to_string(),
        enablement_epoch: state.enablement_epoch().to_string(),
        decision: state.decision(),
        reviewed_plan_digest,
        plan_comparison,
        enabled,
    }
}

fn emit_permission_snapshot(app: &AppHandle, snapshot: &DurePluginPermissionSnapshot) {
    let _ = app.emit(PLUGIN_PERMISSION_EVENT, snapshot.clone());
}

#[tauri::command]
pub(crate) fn dure_plugin_permission_get(
    runtime: State<'_, DurePluginPermissionRuntime>,
    request: DurePluginPermissionTargetRequest,
) -> Result<DurePluginPermissionSnapshot, String> {
    let state = runtime.available()?;
    let (target, plan) = runtime.resolve_current(&request.plugin_id, &request.workspace_root)?;
    state
        .snapshot(&target)
        .map(|current| permission_snapshot(current, plan))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn dure_plugin_permission_decide(
    app: AppHandle,
    runtime: State<'_, DurePluginPermissionRuntime>,
    issue_tracker: State<'_, DureIssueTrackerState>,
    request: DurePluginPermissionDecisionRequest,
) -> Result<DurePluginPermissionSnapshot, String> {
    let state = runtime.available()?;
    let (target, plan) = runtime.resolve_current(&request.plugin_id, &request.workspace_root)?;
    let request_id = parse_request_id(request.request_id)?;
    let expected_revision = parse_revision(&request.expected_record_revision)?;
    let expected_digest = parse_plan_digest(request.expected_plan_digest)?;
    let retirement_plugin_id = request.plugin_id;
    let retirement_event_root = request.workspace_root;
    let retirement_root = target.workspace().canonical_root().to_path_buf();
    let receipt = state
        .decide_with_retirement(
            &target,
            PluginPermissionDecisionCas::new(
                request_id,
                expected_revision,
                &expected_digest,
                &plan,
                request.decision,
            ),
            |_current| {
                issue_tracker
                    .retire_permission_target(
                        &app,
                        &retirement_plugin_id,
                        &retirement_root,
                        &retirement_event_root,
                    )
                    .map_err(PermissionCommandError::from)
            },
        )
        .map_err(|error| error.to_string())?;
    let (current, retirement) = receipt.into_parts();
    if let PluginPermissionRetirementOutcome::Attempted(Err(error)) = retirement {
        eprintln!("[plugin-permission] runtime retirement failed after decision: {error}");
    }
    let snapshot = permission_snapshot(current, plan);
    emit_permission_snapshot(&app, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub(crate) fn dure_plugin_permission_enable(
    app: AppHandle,
    runtime: State<'_, DurePluginPermissionRuntime>,
    issue_tracker: State<'_, DureIssueTrackerState>,
    request: DurePluginPermissionEnableRequest,
) -> Result<DurePluginPermissionSnapshot, String> {
    let state = runtime.available()?;
    let (target, plan) = runtime.resolve_current(&request.plugin_id, &request.workspace_root)?;
    let request_id = parse_request_id(request.request_id)?;
    let expected_revision = parse_revision(&request.expected_record_revision)?;
    let expected_digest = parse_plan_digest(request.expected_plan_digest)?;
    let retirement_plugin_id = request.plugin_id;
    let retirement_event_root = request.workspace_root;
    let retirement_root = target.workspace().canonical_root().to_path_buf();
    let current = state
        .enable_after_retirement(
            &target,
            request_id,
            expected_revision,
            &expected_digest,
            &plan,
            || {
                issue_tracker
                    .retire_permission_target(
                        &app,
                        &retirement_plugin_id,
                        &retirement_root,
                        &retirement_event_root,
                    )
                    .map_err(PermissionCommandError::from)
            },
        )
        .map_err(|error: PermissionCommandError| error.to_string())?;
    let snapshot = permission_snapshot(current, plan);
    emit_permission_snapshot(&app, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub(crate) fn dure_plugin_permission_disable(
    app: AppHandle,
    runtime: State<'_, DurePluginPermissionRuntime>,
    issue_tracker: State<'_, DureIssueTrackerState>,
    request: DurePluginPermissionDisableRequest,
) -> Result<DurePluginPermissionDisableReceipt, String> {
    let state = runtime.available()?;
    let (target, plan) = runtime.resolve_current(&request.plugin_id, &request.workspace_root)?;
    let request_id = parse_request_id(request.request_id)?;
    let retirement_plugin_id = request.plugin_id;
    let retirement_event_root = request.workspace_root;
    let retirement_root = target.workspace().canonical_root().to_path_buf();
    let receipt = state
        .disable_with_retirement(&target, request_id, |_current| {
            issue_tracker
                .retire_permission_target(
                    &app,
                    &retirement_plugin_id,
                    &retirement_root,
                    &retirement_event_root,
                )
                .map_err(PermissionCommandError::from)
        })
        .map_err(|error| error.to_string())?;
    let (transition, retirement) = receipt.into_parts();
    let (current, disable_request_persistence) = transition.into_parts();
    let runtime_retirement = match retirement {
        PluginPermissionRetirementOutcome::Attempted(Ok(_)) => {
            DurePluginPermissionRuntimeRetirement::Succeeded
        }
        PluginPermissionRetirementOutcome::Attempted(Err(error)) => {
            eprintln!("[plugin-permission] runtime retirement failed after disable: {error}");
            DurePluginPermissionRuntimeRetirement::Failed
        }
        PluginPermissionRetirementOutcome::SkippedCurrentEnabled => {
            DurePluginPermissionRuntimeRetirement::Failed
        }
    };
    let snapshot = permission_snapshot(current, plan);
    emit_permission_snapshot(&app, &snapshot);
    Ok(DurePluginPermissionDisableReceipt {
        snapshot,
        disable_request_persistence,
        runtime_retirement,
    })
}
