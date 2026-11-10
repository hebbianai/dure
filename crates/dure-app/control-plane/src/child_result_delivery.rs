//! Tells the agent that started a Run what became of it. When a child
//! finishes a turn and waits, needs input or approval, exits or is stopped,
//! the parent's exact Session receives one durable Message through the same
//! path as `dure send --track`, and is woken to read it.
//!
//! The parent link is the Run's recorded request. Each outcome has a stable
//! interaction ID, so a restarted control plane replays an outcome it already
//! delivered instead of sending it again.
use std::collections::BTreeMap;
use std::sync::Arc;

use dure_app::{
    AgentIdV1, AgentRuntimeBindingAuthorityV1, AgentRuntimeCloseStateV1, AgentRuntimeSelectionV1,
    AgentSpawnJournalStore, AgentSpawnLaunchPlanV1, AgentSpawnParentV1, OperationIdV1,
    ProviderIdV1, WorkflowSessionGenerationV1,
};
use sha2::{Digest, Sha256};
use tokio::time::{Duration, MissedTickBehavior};

use crate::agent_runtime_projection::{AgentRuntimeObservedV1, read_locked};
use crate::hmux_session_inspection::{
    AgentRuntimeAttention, AgentRuntimeLifecycle, HmuxSessionInspection,
};
use crate::{
    BackendDispatchError, ExactSessionMessageOpenBody, ServiceState, authority_stop_fence,
    exact_orchestration_context, now_ms, open_exact_session_message,
    query_hmux_for_runtime_transition, query_hmux_sessions,
};

const TICK: Duration = Duration::from_secs(5);
const LISTING_PAGE: u32 = 256;
const MAX_LISTING_PAGES: usize = 16;
const RETRY_BASE_MS: i64 = 5_000;
const MAX_RETRY_MS: i64 = 5 * 60 * 1_000;
/// A response this long is cut; the parent can read the rest from the child.
const MAX_RESPONSE_BYTES: usize = 16 * 1024;
const MAX_PULL_REQUESTS: usize = 8;
const GITHUB: &str = "https://github.com/";

pub(crate) async fn run_loop(state: Arc<ServiceState>) {
    let mut interval = tokio::time::interval(TICK);
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut deliveries = ChildResultDeliveries::default();
    loop {
        interval.tick().await;
        if !state.is_mutation_authority() {
            continue;
        }
        // A failed pass leaves every undelivered outcome to the next tick.
        let _ = tick(&state, &mut deliveries).await;
    }
}

/// What this control plane has delivered since it started. It is a cache in
/// front of the interaction store, which remains the durable record.
#[derive(Default)]
pub(crate) struct ChildResultDeliveries {
    children: BTreeMap<OperationIdV1, LinkedChild>,
}

struct LinkedChild {
    agent_id: AgentIdV1,
    name: String,
    parent: AgentSpawnParentV1,
    /// The marker of the last outcome the parent received.
    delivered: Option<String>,
    failures: u32,
    retry_at_ms: i64,
    /// The child ended or the parent is gone: nothing more will be sent.
    finished: bool,
}

pub(crate) async fn tick(
    state: &ServiceState,
    deliveries: &mut ChildResultDeliveries,
) -> Result<(), BackendDispatchError> {
    refresh_children(state, deliveries).await?;
    for (operation_id, child) in &mut deliveries.children {
        let now = now_ms().map_err(|_| BackendDispatchError::from("backend_clock_invalid"))?;
        if child.finished || child.retry_at_ms > now {
            continue;
        }
        match deliver_outcome(state, operation_id, child).await {
            Ok(()) => child.failures = 0,
            Err(_) => {
                child.failures = child.failures.saturating_add(1);
                child.retry_at_ms = now.saturating_add(retry_delay_ms(child.failures));
            }
        }
    }
    Ok(())
}

fn retry_delay_ms(failures: u32) -> i64 {
    RETRY_BASE_MS
        .saturating_mul(1_i64 << failures.saturating_sub(1).min(16))
        .min(MAX_RETRY_MS)
}

async fn refresh_children(
    state: &ServiceState,
    deliveries: &mut ChildResultDeliveries,
) -> Result<(), BackendDispatchError> {
    let mut after = None;
    for _ in 0..MAX_LISTING_PAGES {
        let page = state
            .store
            .parent_linked_agent_spawn_operations(after.as_ref(), LISTING_PAGE)
            .await
            .map_err(|_| BackendDispatchError::from("child_result_listing_unavailable"))?;
        for operation_id in &page {
            if deliveries.children.contains_key(operation_id) {
                continue;
            }
            let Some(receipt) = state
                .store
                .agent_spawn_receipt(operation_id)
                .await
                .map_err(|_| BackendDispatchError::from("child_result_listing_unavailable"))?
            else {
                continue;
            };
            let Some(parent) = receipt.plan.request.parent.clone() else {
                continue;
            };
            deliveries.children.insert(
                operation_id.clone(),
                LinkedChild {
                    agent_id: receipt.plan.agent_id.clone(),
                    name: receipt.plan.request.agent_name.clone(),
                    parent,
                    delivered: None,
                    failures: 0,
                    retry_at_ms: 0,
                    // Chat-runtime children have no terminal turn to report yet.
                    finished: !matches!(
                        receipt.plan.launch,
                        AgentSpawnLaunchPlanV1::NativeCli { .. }
                    ),
                },
            );
        }
        if page.len() < LISTING_PAGE as usize {
            break;
        }
        after = page.last().cloned();
    }
    Ok(())
}

/// What a child did that its parent is told about.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ChildOutcome {
    TurnCompleted,
    InputRequired,
    ApprovalRequired,
    Error,
    Exited,
    Stopped,
}

impl ChildOutcome {
    fn ends_run(self) -> bool {
        matches!(self, Self::Exited | Self::Stopped)
    }

    fn code(self) -> &'static str {
        match self {
            Self::TurnCompleted => "turn_completed",
            Self::InputRequired => "input_required",
            Self::ApprovalRequired => "approval_required",
            Self::Error => "error",
            Self::Exited => "exited",
            Self::Stopped => "stopped",
        }
    }
}

struct ObservedOutcome {
    outcome: ChildOutcome,
    /// Distinguishes this outcome from every earlier one of the same Run.
    marker: String,
    /// The native conversation whose newest answer is the child's result.
    history: Option<(AgentRuntimeSelectionV1, String)>,
}

async fn deliver_outcome(
    state: &ServiceState,
    operation_id: &OperationIdV1,
    child: &mut LinkedChild,
) -> Result<(), BackendDispatchError> {
    let Some(observed) = observe_child(state, &child.agent_id).await? else {
        return Ok(());
    };
    if child.delivered.as_deref() == Some(observed.marker.as_str()) {
        child.finished = observed.outcome.ends_run();
        return Ok(());
    }
    let Some(parent) = parent_session(state, &child.parent).await? else {
        // The parent's Session has exited; no later outcome can reach it.
        child.finished = true;
        return Ok(());
    };
    let context = exact_orchestration_context(state, &parent).await?;
    let final_response = match &observed.history {
        // History is a convenience: the outcome is still worth reporting
        // when the provider's history can't be read.
        Some((selection, conversation)) => {
            crate::agent_runtime_native_io::native_final_response(state, selection, conversation)
                .await
                .unwrap_or(None)
        }
        None => None,
    };
    let (title, description_markdown) = result_message(
        &child.name,
        &child.agent_id,
        operation_id,
        observed.outcome,
        final_response.as_deref(),
    );
    let interaction_id = interaction_id(operation_id, &child.parent, &observed.marker);
    let opened = open_exact_session_message(
        state,
        ExactSessionMessageOpenBody {
            schema_version: agent_orchestration::domain::INTERACTION_SCHEMA_VERSION,
            session: parent,
            expected_endpoint_ref: context.endpoint_fence.endpoint_ref.as_str().to_owned(),
            idempotency_key: interaction_id.clone(),
            interaction_id,
            title,
            description_markdown,
            opened_at_ms: now_ms()
                .map_err(|_| BackendDispatchError::from("backend_clock_invalid"))?,
        },
    )
    .await;
    match opened {
        Ok(_) => {}
        // The stable ID already opened this outcome, before a restart.
        Err(error) if already_opened(&error) => {}
        Err(error) => return Err(error),
    }
    child.delivered = Some(observed.marker);
    child.finished = observed.outcome.ends_run();
    Ok(())
}

/// A replay carries a new open time, so the same key is a conflict rather
/// than an idempotent receipt. After the parent's Dispatch rolled over, the
/// same interaction ID already exists under its authority.
fn already_opened(error: &BackendDispatchError) -> bool {
    error.code == "orchestration_idempotency_conflict"
        || (error.code == "orchestration_state_conflict"
            && error
                .details
                .as_ref()
                .and_then(|details| details.get("reasonCode"))
                .is_some_and(|code| code == "interaction_id_exists"))
}

async fn observe_child(
    state: &ServiceState,
    agent_id: &AgentIdV1,
) -> Result<Option<ObservedOutcome>, BackendDispatchError> {
    let observed = {
        let _guard = state.agent_operations.acquire(agent_id).await;
        read_locked(state, agent_id).await?
    };
    let (selection, authority) = match observed {
        AgentRuntimeObservedV1::Closed(close) => {
            return Ok((close.state == AgentRuntimeCloseStateV1::Stopped).then(|| {
                ObservedOutcome {
                    outcome: ChildOutcome::Stopped,
                    marker: format!("stopped:{}", close.intent.operation_id.as_str()),
                    history: None,
                }
            }));
        }
        AgentRuntimeObservedV1::Stable {
            selection,
            authority,
        } => match *authority {
            AgentRuntimeBindingAuthorityV1::NativeCli { authority } => (*selection, authority),
            _ => return Ok(None),
        },
        // A transition is still choosing the runtime; observe it later.
        _ => return Ok(None),
    };
    let inspection = query_hmux_for_runtime_transition(
        &state.hmux_identity,
        &authority.binding.session_id,
        &authority.runtime_workspace_id,
        &authority_stop_fence(&authority),
    )
    .await
    .map_err(|failure| BackendDispatchError::from(failure.code()))?;
    if inspection.provider_id != selection.provider_id.as_str() {
        return Ok(None);
    }
    let conversation = inspection
        .provider_conversation_identity
        .as_ref()
        .map(|identity| identity.conversation_id.clone())
        .or_else(|| authority.binding.provider_conversation_id.clone());
    let Some(outcome) = classify(&inspection) else {
        return Ok(None);
    };
    let count = inspection.turn_completed_count().unwrap_or(0);
    let marker = match outcome {
        ChildOutcome::Exited => format!("exited:{}", authority.terminal_epoch),
        _ => format!("{}:{}:{count}", outcome.code(), authority.terminal_epoch),
    };
    // Only an answered turn has a final response; a pending question or
    // approval is the provider's prompt, not its result.
    let answered =
        matches!(outcome, ChildOutcome::TurnCompleted | ChildOutcome::Exited) && count > 0;
    let history = conversation
        .filter(|_| answered)
        .map(|conversation| (selection, conversation));
    Ok(Some(ObservedOutcome {
        outcome,
        marker,
        history,
    }))
}

/// The outcome the Host reports, if any. Working, starting and background
/// work report nothing; silence and terminal output are never evidence.
pub(crate) fn classify(inspection: &HmuxSessionInspection) -> Option<ChildOutcome> {
    if inspection.is_exited_exact() {
        return Some(ChildOutcome::Exited);
    }
    let runtime = inspection.agent_runtime_state.as_ref()?;
    if runtime.lifecycle == AgentRuntimeLifecycle::Exited {
        return Some(ChildOutcome::Exited);
    }
    match runtime.attention {
        AgentRuntimeAttention::InputRequired => return Some(ChildOutcome::InputRequired),
        AgentRuntimeAttention::ApprovalRequired => return Some(ChildOutcome::ApprovalRequired),
        AgentRuntimeAttention::Error => return Some(ChildOutcome::Error),
        AgentRuntimeAttention::None => {}
    }
    (inspection.is_agent_quiescent() && inspection.turn_completed_count().unwrap_or(0) > 0)
        .then_some(ChildOutcome::TurnCompleted)
}

/// The parent's current generation, or `None` once its Session has exited.
async fn parent_session(
    state: &ServiceState,
    parent: &AgentSpawnParentV1,
) -> Result<Option<WorkflowSessionGenerationV1>, BackendDispatchError> {
    let value = query_hmux_sessions(
        &state.hmux_identity,
        &[
            "session".into(),
            "show".into(),
            parent.session_id.clone(),
            "--workspace".into(),
            parent.workspace_id.clone(),
        ],
    )
    .await?;
    let inspection: HmuxSessionInspection = serde_json::from_value(value)
        .map_err(|_| BackendDispatchError::from("hmux_session_payload_invalid"))?;
    if inspection.session_id != parent.session_id || inspection.workspace_id != parent.workspace_id
    {
        return Err("hmux_descriptor_mismatch".into());
    }
    if inspection.lifecycle == "exited" {
        return Ok(None);
    }
    // The message path verifies this exact generation again before writing.
    Ok(Some(WorkflowSessionGenerationV1 {
        session_id: inspection.session_id,
        workspace_id: inspection.workspace_id,
        provider_id: ProviderIdV1::new(inspection.provider_id)
            .map_err(|_| BackendDispatchError::from("hmux_session_payload_invalid"))?,
        runner_principal: inspection.runner_principal,
        runner_instance: inspection.runner_instance,
        channel_epoch: inspection.channel_epoch,
        host_instance_id: inspection.host_instance_id,
        terminal_epoch: inspection.terminal_epoch,
    }))
}

/// One interaction per outcome and parent. The same outcome always maps to
/// the same ID, which is also its idempotency key.
pub(crate) fn interaction_id(
    operation_id: &OperationIdV1,
    parent: &AgentSpawnParentV1,
    marker: &str,
) -> String {
    let mut hash = Sha256::new();
    for part in [
        operation_id.as_str(),
        &parent.session_id,
        &parent.workspace_id,
        marker,
    ] {
        hash.update((part.len() as u64).to_be_bytes());
        hash.update(part.as_bytes());
    }
    let digest = hash.finalize();
    let hex: String = digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("message.child-result.{hex}")
}

pub(crate) fn result_message(
    name: &str,
    agent_id: &AgentIdV1,
    operation_id: &OperationIdV1,
    outcome: ChildOutcome,
    final_response: Option<&str>,
) -> (String, String) {
    let (title, state) = match outcome {
        ChildOutcome::TurnCompleted => (
            format!("{name} finished a turn"),
            "finished a turn and is waiting for more work",
        ),
        ChildOutcome::InputRequired => (format!("{name} needs input"), "is waiting for input"),
        ChildOutcome::ApprovalRequired => (
            format!("{name} needs approval"),
            "is waiting for an approval",
        ),
        ChildOutcome::Error => (
            format!("{name} stopped on an error"),
            "stopped on an error and is waiting",
        ),
        ChildOutcome::Exited => (format!("{name} exited"), "exited"),
        ChildOutcome::Stopped => (format!("{name} was stopped"), "was stopped"),
    };
    let mut body = format!("Your child Run **{name}** {state}.\n");
    let response = final_response
        .map(str::trim)
        .filter(|text| !text.is_empty());
    if let Some(response) = response {
        let links = pull_request_links(response);
        if !links.is_empty() {
            body.push_str("\nPull requests:\n");
            for link in links {
                body.push_str(&format!("- {link}\n"));
            }
        }
        let (shown, cut) = truncate(response, MAX_RESPONSE_BYTES);
        body.push_str("\nFinal response:\n\n");
        for line in shown.lines() {
            body.push_str(if line.is_empty() { ">" } else { "> " });
            body.push_str(line);
            body.push('\n');
        }
        if cut {
            body.push_str(">\n> (cut; read the rest with `dure read` below)\n");
        }
    }
    let next = match outcome {
        ChildOutcome::Exited | ChildOutcome::Stopped => {
            format!("Read its terminal with `dure read {name}`.")
        }
        _ => format!(
            "Read its terminal with `dure read {name}`, or answer it with `dure send {name} <text>`."
        ),
    };
    body.push_str(&format!(
        "\n{next}\nAgent `{}` · Run `{}` · outcome `{}`.\n",
        agent_id.as_str(),
        operation_id.as_str(),
        outcome.code()
    ));
    (title, body)
}

fn truncate(text: &str, max_bytes: usize) -> (&str, bool) {
    if text.len() <= max_bytes {
        return (text, false);
    }
    let mut end = max_bytes;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (&text[..end], true)
}

/// GitHub pull request links named in a response, normalized and in order.
pub(crate) fn pull_request_links(text: &str) -> Vec<String> {
    let mut links = Vec::new();
    for (start, _) in text.match_indices(GITHUB) {
        let path = &text[start + GITHUB.len()..];
        let mut parts = path.splitn(4, '/');
        let (Some(owner), Some(repository), Some("pull"), Some(number)) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let digits: String = number.chars().take_while(char::is_ascii_digit).collect();
        if !github_name(owner) || !github_name(repository) || digits.is_empty() {
            continue;
        }
        let link = format!("{GITHUB}{owner}/{repository}/pull/{digits}");
        if !links.contains(&link) {
            links.push(link);
        }
        if links.len() == MAX_PULL_REQUESTS {
            break;
        }
    }
    links
}

fn github_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn inspection(lifecycle: &str, runtime: serde_json::Value) -> HmuxSessionInspection {
        serde_json::from_value(json!({
            "schema_version": 1,
            "session_id": "child-session",
            "workspace_id": "child-workspace",
            "session_class": "managed",
            "lifecycle": lifecycle,
            "provider_id": "codex",
            "runner_principal": "runner",
            "runner_instance": "instance",
            "channel_epoch": "1",
            "host_instance_id": "host",
            "terminal_epoch": "terminal",
            "output_seq": "9",
            "health": if lifecycle == "exited" { "exited" } else { "healthy" },
            "agentRuntimeState": runtime,
            "controllerInputPending": false,
        }))
        .unwrap()
    }

    fn runtime(activity: &str, attention: &str, turns: &str) -> serde_json::Value {
        json!({
            "terminal_epoch": "terminal",
            "revision": "3",
            "observed_through_output_seq": "9",
            "turn_completed_count": turns,
            "lifecycle": "running",
            "activity": activity,
            "attention": attention,
            "attention_id": if attention == "none" { None } else { Some("attention-1") },
            "background_work": false,
        })
    }

    #[test]
    fn host_states_classify_into_the_outcomes_a_parent_is_told() {
        let cases = [
            (
                inspection("ready", runtime("waiting", "none", "1")),
                Some(ChildOutcome::TurnCompleted),
            ),
            // A fresh child at its prompt has answered nothing yet.
            (inspection("ready", runtime("waiting", "none", "0")), None),
            (inspection("ready", runtime("working", "none", "4")), None),
            (
                inspection("ready", runtime("working", "input_required", "0")),
                Some(ChildOutcome::InputRequired),
            ),
            (
                inspection("ready", runtime("working", "approval_required", "2")),
                Some(ChildOutcome::ApprovalRequired),
            ),
            (
                inspection("ready", runtime("waiting", "error", "2")),
                Some(ChildOutcome::Error),
            ),
            (
                inspection("exited", runtime("waiting", "none", "2")),
                Some(ChildOutcome::Exited),
            ),
            (inspection("ready", serde_json::Value::Null), None),
        ];
        for (observed, expected) in cases {
            assert_eq!(classify(&observed), expected);
        }
        let mut background = runtime("waiting", "none", "1");
        background["background_work"] = json!(true);
        assert_eq!(classify(&inspection("ready", background)), None);
    }

    #[test]
    fn interaction_ids_are_stable_per_outcome_and_parent() {
        let operation = OperationIdV1::new("operation-1").unwrap();
        let parent = AgentSpawnParentV1 {
            session_id: "parent-session".into(),
            workspace_id: "parent-workspace".into(),
        };
        let first = interaction_id(&operation, &parent, "turn_completed:terminal:1");
        assert_eq!(
            first,
            interaction_id(&operation, &parent, "turn_completed:terminal:1")
        );
        assert!(first.starts_with("message.child-result."));
        assert!(first.len() <= agent_orchestration::domain::MAX_IDEMPOTENCY_KEY_BYTES);
        assert_ne!(
            first,
            interaction_id(&operation, &parent, "turn_completed:terminal:2")
        );
        let other_parent = AgentSpawnParentV1 {
            workspace_id: "other-workspace".into(),
            ..parent.clone()
        };
        assert_ne!(
            first,
            interaction_id(&operation, &other_parent, "turn_completed:terminal:1")
        );
        // Length-prefixed parts cannot collide by moving a separator.
        assert_ne!(
            interaction_id(&OperationIdV1::new("operation-1a").unwrap(), &parent, "b"),
            interaction_id(&operation, &parent, "ab")
        );
    }

    #[test]
    fn pull_request_links_are_found_normalized_and_deduplicated() {
        let text = "Opened https://github.com/hebbianai/dure/pull/512. Review \
            (https://github.com/hebbianai/dure/pull/512#issuecomment-1) and \
            https://github.com/other/repo.rs/pull/7/files; not \
            https://github.com/hebbianai/dure/issues/421 or https://github.com/a/pull/9 \
            or https://github.com/hebbianai/dure/pull/";
        assert_eq!(
            pull_request_links(text),
            [
                "https://github.com/hebbianai/dure/pull/512",
                "https://github.com/other/repo.rs/pull/7",
            ]
        );
        let many: String = (0..20)
            .map(|number| format!("https://github.com/o/r/pull/{number} "))
            .collect();
        assert_eq!(pull_request_links(&many).len(), MAX_PULL_REQUESTS);
    }

    #[test]
    fn a_finished_turn_carries_its_response_and_pull_requests() {
        let agent = AgentIdV1::new("agent-1").unwrap();
        let operation = OperationIdV1::new("operation-1").unwrap();
        let (title, body) = result_message(
            "fix-12",
            &agent,
            &operation,
            ChildOutcome::TurnCompleted,
            Some("Done.\n\nPR: https://github.com/hebbianai/dure/pull/512\n"),
        );
        assert_eq!(title, "fix-12 finished a turn");
        assert_eq!(
            body,
            "Your child Run **fix-12** finished a turn and is waiting for more work.\n\
             \nPull requests:\n- https://github.com/hebbianai/dure/pull/512\n\
             \nFinal response:\n\n> Done.\n>\n> PR: https://github.com/hebbianai/dure/pull/512\n\
             \nRead its terminal with `dure read fix-12`, or answer it with `dure send fix-12 <text>`.\n\
             Agent `agent-1` · Run `operation-1` · outcome `turn_completed`.\n"
        );
    }

    #[test]
    fn other_outcomes_state_what_happened_without_a_response() {
        let agent = AgentIdV1::new("agent-1").unwrap();
        let operation = OperationIdV1::new("operation-1").unwrap();
        for (outcome, title, state) in [
            (
                ChildOutcome::InputRequired,
                "fix-12 needs input",
                "is waiting for input",
            ),
            (
                ChildOutcome::ApprovalRequired,
                "fix-12 needs approval",
                "is waiting for an approval",
            ),
            (
                ChildOutcome::Error,
                "fix-12 stopped on an error",
                "stopped on an error and is waiting",
            ),
            (ChildOutcome::Exited, "fix-12 exited", "exited"),
            (ChildOutcome::Stopped, "fix-12 was stopped", "was stopped"),
        ] {
            let (shown, body) = result_message("fix-12", &agent, &operation, outcome, None);
            assert_eq!(shown, title);
            assert!(body.starts_with(&format!("Your child Run **fix-12** {state}.\n")));
            assert!(!body.contains("Final response"));
            assert!(body.contains(&format!("outcome `{}`", outcome.code())));
            assert_eq!(body.contains("dure send"), !outcome.ends_run());
        }
    }

    #[test]
    fn a_long_response_is_cut_on_a_character_boundary_within_the_message_limit() {
        let agent = AgentIdV1::new("agent-1").unwrap();
        let operation = OperationIdV1::new("operation-1").unwrap();
        let response = "é".repeat(MAX_RESPONSE_BYTES);
        let (_, body) = result_message(
            "fix-12",
            &agent,
            &operation,
            ChildOutcome::TurnCompleted,
            Some(&response),
        );
        assert!(body.contains("(cut; read the rest with `dure read` below)"));
        assert!(body.len() < agent_orchestration::domain::MAX_MARKDOWN_BYTES);
        let (shown, cut) = truncate(&response, MAX_RESPONSE_BYTES - 1);
        assert!(cut);
        assert_eq!(shown.len(), MAX_RESPONSE_BYTES - 2);
    }

    #[test]
    fn failed_deliveries_back_off_up_to_five_minutes() {
        assert_eq!(retry_delay_ms(1), 5_000);
        assert_eq!(retry_delay_ms(2), 10_000);
        assert_eq!(retry_delay_ms(4), 40_000);
        assert_eq!(retry_delay_ms(7), MAX_RETRY_MS);
        assert_eq!(retry_delay_ms(u32::MAX), MAX_RETRY_MS);
    }
}
