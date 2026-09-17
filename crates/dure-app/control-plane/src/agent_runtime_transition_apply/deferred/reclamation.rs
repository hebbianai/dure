//! Read-only projection of the existing transition journal. A confirmed source
//! stop is not a byte measurement or proof that every auxiliary process exited.

use dure_app::{
    AgentIdV1, AgentRuntimeBindingAuthorityV1, AgentRuntimeDeferredTargetV1,
    AgentRuntimeTransitionRecordV1, AgentRuntimeTransitionStateV1, OperationIdV1, ProviderIdV1,
};
use serde::Serialize;

use crate::ServiceState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ReclamationObservation {
    schema_version: u16,
    state: &'static str,
    observed_at_ms: Option<i64>,
    scope: &'static str,
    scanned: usize,
    limit: usize,
    partial: bool,
    reason_code: Option<&'static str>,
    entries: Vec<ReclamationEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReclamationEntry {
    agent_id: AgentIdV1,
    provider_id: ProviderIdV1,
    operation_id: OperationIdV1,
    journal_revision: i64,
    stage: AgentRuntimeTransitionStateV1,
    stop_state: &'static str,
    wake_state: &'static str,
    source_session_id: Option<String>,
    requested_at_ms: i64,
    updated_at_ms: i64,
    reason_code: Option<String>,
}

impl ReclamationEntry {
    fn from_record(record: AgentRuntimeTransitionRecordV1) -> Option<Self> {
        use AgentRuntimeTransitionStateV1 as Stage;
        let activation = record.deferred_target.as_ref()?;
        let (stop_state, wake_state) = outcomes(record.state, activation);
        let source_session_id = match &record.intent.source_authority {
            AgentRuntimeBindingAuthorityV1::NativeCli { authority } => {
                Some(authority.binding.session_id.clone())
            }
            AgentRuntimeBindingAuthorityV1::StructuredProtocol { .. } => None,
        };
        Some(Self {
            agent_id: record.intent.source.agent_id,
            provider_id: record.intent.source.provider_id,
            operation_id: record.intent.operation_id,
            journal_revision: record.journal_revision,
            stage: record.state,
            stop_state,
            wake_state,
            source_session_id,
            requested_at_ms: record.created_at_ms,
            updated_at_ms: record.updated_at_ms,
            reason_code: record
                .target_failure
                .map(|failure| failure.provider_code)
                .or_else(|| {
                    (record.state == Stage::SourceRetained)
                        .then(|| "agent_runtime_source_retained".into())
                }),
        })
    }
}

fn outcomes(
    stage: AgentRuntimeTransitionStateV1,
    activation: &AgentRuntimeDeferredTargetV1,
) -> (&'static str, &'static str) {
    use AgentRuntimeTransitionStateV1 as Stage;
    let stop_state = match stage {
        Stage::Admitted => "unconfirmed",
        Stage::SourceRetained => "refused",
        Stage::SourceStopped | Stage::RepairRequired | Stage::TargetStarted | Stage::Committed => {
            "completed"
        }
        Stage::Superseded => match activation {
            AgentRuntimeDeferredTargetV1::Requested { .. } => "completed",
            AgentRuntimeDeferredTargetV1::Waiting => "unconfirmed",
        },
    };
    let wake_state = match (stage, activation) {
        (Stage::Superseded, _) => "superseded",
        (_, AgentRuntimeDeferredTargetV1::Waiting) => "not_requested",
        (Stage::Committed, _) => "completed",
        (Stage::RepairRequired, _) => "failed",
        _ => "requested",
    };
    (stop_state, wake_state)
}

pub(super) async fn observe(state: &ServiceState) -> ReclamationObservation {
    let result = state.store.recent_agent_runtime_transitions().await;
    let mut observation = ReclamationObservation {
        schema_version: 1,
        state: "unavailable",
        observed_at_ms: crate::now_ms().ok(),
        scope: "latest_runtime_transition_admissions",
        scanned: 0,
        limit: 64,
        partial: true,
        reason_code: Some("runtime_reclamation_journal_unavailable"),
        entries: Vec::new(),
    };
    if let Ok((records, partial)) = result {
        if observation.observed_at_ms.is_none() {
            observation.reason_code = Some("runtime_reclamation_clock_unavailable");
            return observation;
        }
        observation.state = "available";
        observation.scanned = records.len();
        observation.partial = partial;
        observation.reason_code = None;
        observation.entries = records
            .into_iter()
            .filter_map(ReclamationEntry::from_record)
            .collect();
    }
    observation
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reclamation_outcomes_do_not_confuse_source_stop_with_wake() {
        use AgentRuntimeTransitionStateV1 as Stage;
        let waiting = AgentRuntimeDeferredTargetV1::Waiting;
        let requested = AgentRuntimeDeferredTargetV1::Requested {
            operation_id: OperationIdV1::new("wake-1").unwrap(),
            requested_at_ms: 100,
        };
        for (stage, activation, expected) in [
            (Stage::Admitted, &waiting, ("unconfirmed", "not_requested")),
            (
                Stage::SourceRetained,
                &waiting,
                ("refused", "not_requested"),
            ),
            (
                Stage::SourceStopped,
                &waiting,
                ("completed", "not_requested"),
            ),
            (Stage::Superseded, &waiting, ("unconfirmed", "superseded")),
            (Stage::SourceStopped, &requested, ("completed", "requested")),
            (Stage::TargetStarted, &requested, ("completed", "requested")),
            (Stage::RepairRequired, &requested, ("completed", "failed")),
            (Stage::Committed, &requested, ("completed", "completed")),
            (Stage::Superseded, &requested, ("completed", "superseded")),
        ] {
            assert_eq!(outcomes(stage, activation), expected, "{stage:?}");
        }
    }
}
