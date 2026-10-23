//! Machine adapter for bounded liveness probes over exact local identities.
//!
//! Parsing and receipt projection live outside the CLI dispatcher so the
//! provider-neutral batching contract stays reviewable as one small surface.

use crate::CliError;
use clap::Args;
use hmux_client::{
    AgentRuntimeStateDescriptor, ExactSessionProbeResult, MAX_EXACT_SESSION_PROBE_TARGETS,
    SessionHealth, SessionSelector, WorkingDirectoryDescriptor,
};

pub(crate) const RUNTIME_STATE_CAPABILITY: &str = "exact_session_probe_runtime_state_v1";
pub(crate) const WORKING_DIRECTORY_CAPABILITY: &str = "exact_session_probe_working_directory_v1";

#[derive(Args, Debug)]
pub(crate) struct SessionProbeBatchArgs {
    /// JSON array of {"sessionId":"...","workspaceId":"..."} exact targets.
    ///
    /// Both fields are required. Duplicate targets and batches larger than 128
    /// are refused before discovery starts.
    #[arg(long, value_name = "JSON")]
    pub(crate) targets_json: String,

    /// Total wall-clock budget shared by exact discovery and at most 8 probes.
    /// Targets not reached inside it remain unknown, never dead.
    #[arg(long, default_value_t = 1_000, value_parser = clap::value_parser!(u64).range(0..=60_000))]
    pub(crate) probe_budget_ms: u64,

    /// Include Host runtime state and its observed output sequence for healthy
    /// exact generations. Requires exact_session_probe_runtime_state_v1.
    #[arg(long)]
    pub(crate) include_runtime_state: bool,

    /// Include the Host working directory and its observed output sequence
    /// for healthy exact generations. Requires
    /// exact_session_probe_working_directory_v1. A separate flag, because
    /// older receipt readers refuse keys they did not request.
    #[arg(long)]
    pub(crate) include_working_directory: bool,
}

/// Optional Host observations a probe batch receipt carries.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct ReceiptProjections {
    pub(crate) runtime_state: bool,
    pub(crate) working_directory: bool,
}

impl From<&SessionProbeBatchArgs> for ReceiptProjections {
    fn from(args: &SessionProbeBatchArgs) -> Self {
        Self {
            runtime_state: args.include_runtime_state,
            working_directory: args.include_working_directory,
        }
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionProbeBatchTarget {
    session_id: String,
    workspace_id: String,
}

pub(crate) fn parse_selectors(
    args: &SessionProbeBatchArgs,
) -> Result<Vec<SessionSelector>, CliError> {
    let targets: Vec<SessionProbeBatchTarget> =
        serde_json::from_str(&args.targets_json).map_err(|error| {
            CliError(format!(
                "--targets-json must be an array of exact sessionId/workspaceId objects: {error}"
            ))
        })?;
    if targets.len() > MAX_EXACT_SESSION_PROBE_TARGETS {
        return Err(CliError(format!(
            "--targets-json has {} targets; maximum is {MAX_EXACT_SESSION_PROBE_TARGETS}",
            targets.len()
        )));
    }
    Ok(targets
        .into_iter()
        .map(|target| SessionSelector::new(target.session_id, Some(target.workspace_id)))
        .collect())
}

pub(crate) fn render(
    results: Vec<ExactSessionProbeResult>,
    json: bool,
    projections: ReceiptProjections,
) -> Result<String, serde_json::Error> {
    let receipt = batch_receipt(results, projections);
    if json {
        return serde_json::to_string_pretty(&receipt).map(|payload| format!("{payload}\n"));
    }
    if receipt.results.is_empty() {
        return Ok("No exact Hmux session targets were requested.\n".into());
    }
    Ok(receipt
        .results
        .iter()
        .map(|result| {
            format!(
                "{}\t{}\t{}\t{}\n",
                result.liveness, result.status, result.workspace_id, result.session_id
            )
        })
        .collect::<Vec<_>>()
        .concat())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ExactSessionProbeBatchReceipt {
    schema_version: u8,
    complete: bool,
    results: Vec<ExactSessionProbeReceipt>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ExactSessionProbeReceipt {
    session_id: String,
    workspace_id: String,
    liveness: &'static str,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    runner_principal: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    runner_instance: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    channel_epoch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    host_instance_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    terminal_epoch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output_sequence: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_runtime_state: Option<AgentRuntimeStateDescriptor>,
    #[serde(skip_serializing_if = "Option::is_none")]
    working_directory: Option<WorkingDirectoryDescriptor>,
}

fn batch_receipt(
    results: Vec<ExactSessionProbeResult>,
    projections: ReceiptProjections,
) -> ExactSessionProbeBatchReceipt {
    let results = results
        .into_iter()
        .map(|result| match result {
            ExactSessionProbeResult::Inspection(inspection) => {
                let (liveness, status) = probe_health(inspection.health);
                // A discovered descriptor whose handshake exhausted the budget
                // is still unobserved. Keep the same receipt as an unreached
                // target so one slow Host does not invalidate the whole batch.
                if inspection.health == SessionHealth::Unprobed {
                    return receipt_without_generation(
                        SessionSelector::new(
                            inspection.session_id.clone(),
                            Some(inspection.workspace_id.clone()),
                        ),
                        liveness,
                        status,
                        None,
                    );
                }
                // Each projection is fenced by the output sequence of the
                // same exact Host observation, so either one carries it.
                let healthy = inspection.health == SessionHealth::Healthy;
                let include_runtime_state = projections.runtime_state && healthy;
                let include_working_directory = projections.working_directory && healthy;
                ExactSessionProbeReceipt {
                    session_id: inspection.session_id.clone(),
                    workspace_id: inspection.workspace_id.clone(),
                    liveness,
                    status,
                    error_code: None,
                    runner_principal: Some(inspection.runner_principal.clone()),
                    runner_instance: Some(inspection.runner_instance.clone()),
                    channel_epoch: Some(inspection.channel_epoch.clone()),
                    host_instance_id: Some(inspection.host_instance_id.clone()),
                    terminal_epoch: Some(inspection.terminal_epoch.clone()),
                    output_sequence: (include_runtime_state || include_working_directory)
                        .then(|| inspection.output_seq.clone()),
                    agent_runtime_state: include_runtime_state
                        .then(|| inspection.agent_runtime_state.clone())
                        .flatten(),
                    working_directory: include_working_directory
                        .then(|| inspection.working_directory.clone())
                        .flatten(),
                }
            }
            ExactSessionProbeResult::NotFound(selector) => {
                receipt_without_generation(selector, "dead", "not_found", None)
            }
            ExactSessionProbeResult::LookupFailed {
                selector,
                error_code,
            } => receipt_without_generation(selector, "unknown", "lookup_failed", Some(error_code)),
            ExactSessionProbeResult::Unprobed(selector) => {
                receipt_without_generation(selector, "unknown", "unprobed", None)
            }
        })
        .collect::<Vec<_>>();
    ExactSessionProbeBatchReceipt {
        schema_version: 1,
        complete: results.iter().all(|result| result.liveness != "unknown"),
        results,
    }
}

fn receipt_without_generation(
    selector: SessionSelector,
    liveness: &'static str,
    status: &'static str,
    error_code: Option<String>,
) -> ExactSessionProbeReceipt {
    ExactSessionProbeReceipt {
        session_id: selector.session_id,
        workspace_id: selector.workspace_id.unwrap_or_default(),
        liveness,
        status,
        error_code,
        runner_principal: None,
        runner_instance: None,
        channel_epoch: None,
        host_instance_id: None,
        terminal_epoch: None,
        output_sequence: None,
        agent_runtime_state: None,
        working_directory: None,
    }
}

fn probe_health(health: SessionHealth) -> (&'static str, &'static str) {
    match health {
        SessionHealth::Healthy => ("alive", "healthy"),
        SessionHealth::StaleTransport => ("dead", "stale_transport"),
        SessionHealth::IncompatibleProtocol => ("dead", "incompatible_protocol"),
        SessionHealth::Exited => ("dead", "exited"),
        // A replacement raced the descriptor read. The old generation is no
        // longer valid, but this probe did not establish the replacement's
        // health, so adapters must not convert the race into a dead verdict.
        SessionHealth::GenerationChanged => ("unknown", "generation_changed"),
        SessionHealth::Unprobed => ("unknown", "unprobed"),
    }
}
