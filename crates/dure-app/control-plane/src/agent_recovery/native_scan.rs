//! Wakes the recovery owner for native terminal Agents.
//!
//! A Chat Agent's failure arrives as a conversation notification. A native
//! terminal's failure lives only in its Hmux Host, so this scanner probes the
//! Hosts of native Agents whose provider switches accounts or continues after
//! a reset, in bounded batches, and sends the owner each Agent that shows a
//! settled limit failure. It decides nothing: the owner inspects the exact
//! Host again under its per-Agent order before any attempt exists.

use std::collections::BTreeSet;
use std::sync::Arc;

use dure_app::{AgentCheckpointBindingAuthorityV1, AgentIdV1, DomainStore};
use dure_app_sqlite::NativeRecoveryCandidateV1;
use serde::Deserialize;
use tokio::sync::mpsc;
use tokio::time::{Duration, MissedTickBehavior};

use crate::{ServiceState, pro_features, query_hmux_sessions};

const SCAN_INTERVAL: Duration = Duration::from_secs(15);
/// One probe batch, the most targets `hmux session probe-batch` takes.
const SCAN_PAGE: u32 = hmux_client::MAX_EXACT_SESSION_PROBE_TARGETS as u32;
/// Shared by discovery and the batch's probes, inside the query timeout.
const PROBE_BUDGET_MS: &str = "2000";

/// One Host failure episode already sent to the owner by this process.
type Episode = (AgentIdV1, String, String);

pub(crate) async fn scan_native_failures(
    state: Arc<ServiceState>,
    wake: mpsc::UnboundedSender<AgentIdV1>,
) {
    let mut sent = BTreeSet::new();
    let mut timer = tokio::time::interval(SCAN_INTERVAL);
    timer.set_missed_tick_behavior(MissedTickBehavior::Delay);
    while !wake.is_closed() {
        timer.tick().await;
        if !state.is_mutation_authority() || !pro_features::available() {
            continue;
        }
        if let Err(code) = scan(&state, &wake, &mut sent).await {
            eprintln!("Dure native account recovery scan failed: {code}");
        }
    }
}

async fn scan(
    state: &ServiceState,
    wake: &mpsc::UnboundedSender<AgentIdV1>,
    sent: &mut BTreeSet<Episode>,
) -> Result<(), &'static str> {
    let mut failing = BTreeSet::new();
    let mut after = None;
    loop {
        let page = state
            .store
            .agent_native_recovery_candidates(after.as_ref(), SCAN_PAGE)
            .await
            .map_err(|_| "agent_recovery_store_failed")?;
        let complete = page.len() < SCAN_PAGE as usize;
        after = page.last().map(|candidate| candidate.agent_id.clone());
        let mut targets = Vec::new();
        for NativeRecoveryCandidateV1 {
            agent_id,
            unfinished_attempt,
        } in page
        {
            // An unfinished attempt is the owner's until it settles.
            if unfinished_attempt {
                let _ = wake.send(agent_id);
                continue;
            }
            if let Some(authority) = state
                .store
                .agent_checkpoint_binding_authority(&agent_id)
                .await
                .map_err(|_| "agent_recovery_store_failed")?
            {
                targets.push((agent_id, authority));
            }
        }
        for episode in limit_failures(state, &targets).await? {
            if !sent.contains(&episode) {
                let _ = wake.send(episode.0.clone());
            }
            failing.insert(episode);
        }
        if complete {
            break;
        }
    }
    // Each episode is sent at most once per process; one that ended is
    // forgotten, so the set only holds failures that are still open.
    *sent = failing;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProbeBatchReceipt {
    results: Vec<ProbeReceipt>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProbeReceipt {
    session_id: String,
    workspace_id: String,
    status: String,
    runner_principal: Option<String>,
    runner_instance: Option<String>,
    channel_epoch: Option<String>,
    host_instance_id: Option<String>,
    terminal_epoch: Option<String>,
    agent_runtime_state: Option<ProbedRuntimeState>,
}

#[derive(Deserialize)]
struct ProbedRuntimeState {
    lifecycle: String,
    activity: String,
    attention: String,
    attention_id: Option<String>,
    #[serde(default)]
    turn_failure: Option<String>,
}

impl ProbeReceipt {
    /// The healthy probe of exactly this checkpoint's Host generation.
    fn observes(&self, authority: &AgentCheckpointBindingAuthorityV1) -> bool {
        self.status == "healthy"
            && self.session_id == authority.binding.session_id
            && self.workspace_id == authority.runtime_workspace_id
            && self.runner_principal.as_deref() == Some(authority.runner_principal.as_str())
            && self.runner_instance.as_deref() == Some(authority.runner_instance.as_str())
            && self.channel_epoch.as_deref() == Some(authority.channel_epoch.as_str())
            && self.host_instance_id.as_deref() == Some(authority.host_instance_id.as_str())
            && self.terminal_epoch.as_deref() == Some(authority.terminal_epoch.as_str())
    }

    /// The open limit failure episode this probe shows, if any.
    fn limit_failure(&self) -> Option<(&str, &str)> {
        let state = self.agent_runtime_state.as_ref()?;
        (state.lifecycle == "running"
            && state.activity == "waiting"
            && state.attention == "error"
            && matches!(
                state.turn_failure.as_deref(),
                Some("usage_limit" | "rate_limit")
            ))
        .then_some(())?;
        Some((
            self.terminal_epoch.as_deref()?,
            state.attention_id.as_deref()?,
        ))
    }
}

/// Probes one batch of exact Hosts and returns the limit failure episodes
/// they show. A Host the batch cannot reach shows nothing.
async fn limit_failures(
    state: &ServiceState,
    targets: &[(AgentIdV1, AgentCheckpointBindingAuthorityV1)],
) -> Result<Vec<Episode>, &'static str> {
    if targets.is_empty() {
        return Ok(Vec::new());
    }
    let selectors = targets
        .iter()
        .map(|(_, authority)| {
            serde_json::json!({
                "sessionId": authority.binding.session_id,
                "workspaceId": authority.runtime_workspace_id,
            })
        })
        .collect::<Vec<_>>();
    let Ok(value) = query_hmux_sessions(
        &state.hmux_identity,
        &[
            "session".into(),
            "probe-batch".into(),
            "--targets-json".into(),
            serde_json::Value::Array(selectors).to_string(),
            "--probe-budget-ms".into(),
            PROBE_BUDGET_MS.into(),
            "--include-runtime-state".into(),
        ],
    )
    .await
    else {
        return Ok(Vec::new());
    };
    let receipt: ProbeBatchReceipt =
        serde_json::from_value(value).map_err(|_| "hmux_session_payload_invalid")?;
    Ok(targets
        .iter()
        .filter_map(|(agent_id, authority)| {
            let probe = receipt
                .results
                .iter()
                .find(|probe| probe.observes(authority))?;
            let (terminal_epoch, attention_id) = probe.limit_failure()?;
            Some((
                agent_id.clone(),
                terminal_epoch.to_owned(),
                attention_id.to_owned(),
            ))
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn receipt(state: serde_json::Value) -> ProbeReceipt {
        serde_json::from_value(serde_json::json!({
            "sessionId": "session-1",
            "workspaceId": "workspace-1",
            "liveness": "alive",
            "status": "healthy",
            "runnerPrincipal": "principal",
            "runnerInstance": "instance",
            "channelEpoch": "1",
            "hostInstanceId": "host",
            "terminalEpoch": "terminal-1",
            "outputSequence": "9",
            "agentRuntimeState": state,
        }))
        .unwrap()
    }

    fn runtime_state(attention: &str, turn_failure: Option<&str>) -> serde_json::Value {
        let mut state = serde_json::json!({
            "terminal_epoch": "terminal-1",
            "revision": "3",
            "observed_through_output_seq": "9",
            "lifecycle": "running",
            "activity": "waiting",
            "attention": attention,
            "attention_id": "attention-3",
            "source": "provider_event",
            "turn_completed_count": "1",
        });
        if let Some(turn_failure) = turn_failure {
            state["turn_failure"] = turn_failure.into();
        }
        state
    }

    #[test]
    fn only_a_settled_limit_failure_wakes_the_owner() {
        for reason in ["usage_limit", "rate_limit"] {
            assert_eq!(
                receipt(runtime_state("error", Some(reason))).limit_failure(),
                Some(("terminal-1", "attention-3"))
            );
        }
        for (attention, failure) in [
            ("error", Some("provider_error")),
            ("error", Some("a_future_reason")),
            ("error", None),
            ("input_required", None),
        ] {
            assert_eq!(
                receipt(runtime_state(attention, failure)).limit_failure(),
                None
            );
        }
    }
}
