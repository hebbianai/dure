use hmux_client::ManagedStopQuiescenceFence;
use serde::Deserialize;
use std::time::Duration;

#[derive(Clone, Copy, Debug, Default)]
enum SemanticIdleAge {
    #[default]
    Unavailable,
    Observed(Duration),
    Invalid,
}

impl<'de> Deserialize<'de> for SemanticIdleAge {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        // Optional policy evidence cannot invalidate the core descriptor used
        // by resume/rehost. Only the idle consumer rejects malformed metadata.
        Ok(match serde_json::Value::deserialize(deserializer)? {
            serde_json::Value::Null => Self::Unavailable,
            serde_json::Value::String(value) => canonical_u64(&value)
                .map(|age| Self::Observed(Duration::from_millis(age)))
                .unwrap_or(Self::Invalid),
            _ => Self::Invalid,
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum HmuxSessionInspectionFailure {
    AuthorityStale,
    RuntimeIdentityChanged,
    DescriptorUnavailable,
    DescriptorTimeout,
    DescriptorMalformed,
    DescriptorMismatch,
    AgentRuntimeStateMismatch,
    ProviderConversationIdentityMismatch,
}

impl HmuxSessionInspectionFailure {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::AuthorityStale => "agent_runtime_native_authority_stale",
            Self::RuntimeIdentityChanged => "hmux_runtime_identity_changed",
            Self::DescriptorUnavailable => "hmux_descriptor_unavailable",
            Self::DescriptorTimeout => "hmux_descriptor_timeout",
            Self::DescriptorMalformed => "hmux_descriptor_malformed",
            Self::DescriptorMismatch => "hmux_descriptor_mismatch",
            Self::AgentRuntimeStateMismatch => "hmux_agent_runtime_state_mismatch",
            Self::ProviderConversationIdentityMismatch => {
                "hmux_provider_conversation_identity_mismatch"
            }
        }
    }

    pub(crate) fn proves_identity_mismatch(self) -> bool {
        matches!(
            self,
            Self::AuthorityStale
                | Self::DescriptorMalformed
                | Self::DescriptorMismatch
                | Self::AgentRuntimeStateMismatch
                | Self::ProviderConversationIdentityMismatch
        )
    }
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct HmuxSessionInspection {
    pub(crate) schema_version: u16,
    pub(crate) session_id: String,
    pub(crate) workspace_id: String,
    pub(crate) session_class: String,
    pub(crate) lifecycle: String,
    pub(crate) provider_id: String,
    pub(crate) runner_principal: String,
    pub(crate) runner_instance: String,
    pub(crate) channel_epoch: String,
    pub(crate) host_instance_id: String,
    pub(crate) terminal_epoch: String,
    #[serde(default)]
    pub(crate) output_seq: String,
    pub(crate) health: String,
    #[serde(default)]
    capabilities: Vec<String>,
    #[serde(rename = "agentRuntimeState")]
    pub(crate) agent_runtime_state: Option<AgentRuntimeState>,
    #[serde(rename = "controllerInputPending")]
    pub(crate) controller_input_pending: Option<bool>,
    #[serde(default, rename = "semanticIdleMs")]
    semantic_idle_age: SemanticIdleAge,
    #[serde(rename = "providerConversationIdentity")]
    pub(crate) provider_conversation_identity: Option<ProviderConversationIdentity>,
}

impl HmuxSessionInspection {
    pub(crate) fn semantic_idle_age(&self) -> Result<Option<Duration>, &'static str> {
        if !self.capabilities.iter().any(|capability| {
            capability == hmux_session_protocol::SEMANTIC_IDLE_OBSERVATION_CAPABILITY
        }) {
            return Ok(None);
        }
        self.managed_stop_quiescence_fence()?;
        match self.semantic_idle_age {
            SemanticIdleAge::Observed(age) if self.controller_input_pending == Some(false) => {
                Ok(Some(age))
            }
            _ => Err("hmux_semantic_idle_observation_unavailable"),
        }
    }

    pub(crate) fn supports_semantic_quiescent_stop(&self) -> bool {
        self.capabilities.iter().any(|capability| {
            capability == hmux_session_protocol::MANAGED_PROVIDER_SEMANTIC_QUIESCENT_STOP_CAPABILITY
        })
    }

    pub(crate) fn turn_completed_count(&self) -> Option<u64> {
        self.agent_runtime_state
            .as_ref()
            .map(AgentRuntimeState::turn_completed_count)
    }

    pub(crate) fn is_agent_quiescent(&self) -> bool {
        self.agent_runtime_state.as_ref().is_some_and(|state| {
            state.lifecycle == AgentRuntimeLifecycle::Running
                && state.activity == AgentRuntimeActivity::Waiting
                && state.attention == AgentRuntimeAttention::None
                && state.attention_id.is_none()
        })
    }

    pub(crate) fn is_exited_exact(&self) -> bool {
        self.lifecycle == "exited" && self.health == "exited"
    }

    pub(crate) fn managed_stop_quiescence_fence(
        &self,
    ) -> Result<ManagedStopQuiescenceFence, &'static str> {
        let state = self
            .agent_runtime_state
            .as_ref()
            .filter(|_| self.lifecycle == "ready" && self.health == "healthy")
            .filter(|_| self.is_agent_quiescent())
            .ok_or("hmux_agent_runtime_not_quiescent")?;
        // This is the Host's existing input protection, not inferred activity.
        // An older Host leaves it unknown and retains its exact stop fence;
        // missing inspection evidence never becomes an invented `false`.
        if self.controller_input_pending == Some(true) {
            return Err("hmux_controller_input_pending");
        }
        ManagedStopQuiescenceFence::new(
            state.terminal_epoch.clone(),
            canonical_positive_u64(&state.revision).ok_or("hmux_agent_runtime_state_mismatch")?,
            canonical_u64(&self.output_seq).ok_or("hmux_agent_runtime_state_mismatch")?,
        )
        .map_err(|_| "hmux_agent_runtime_state_mismatch")
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentRuntimeLifecycle {
    Starting,
    Running,
    Exited,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentRuntimeActivity {
    Working,
    Waiting,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentRuntimeAttention {
    None,
    InputRequired,
    ApprovalRequired,
    Error,
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct AgentRuntimeState {
    terminal_epoch: String,
    revision: String,
    observed_through_output_seq: String,
    #[serde(default = "zero_u64_string")]
    turn_completed_count: String,
    lifecycle: AgentRuntimeLifecycle,
    activity: AgentRuntimeActivity,
    attention: AgentRuntimeAttention,
    attention_id: Option<String>,
}

impl AgentRuntimeState {
    fn turn_completed_count(&self) -> u64 {
        canonical_u64(&self.turn_completed_count)
            .expect("validated Hmux runtime state must retain a canonical completion count")
    }
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct ProviderConversationIdentity {
    session_id: String,
    workspace_id: String,
    runner_principal: String,
    runner_instance: String,
    channel_epoch: String,
    host_instance_id: String,
    terminal_epoch: String,
    provider_id: String,
    pub(crate) conversation_id: String,
}

pub(crate) struct ExpectedHmuxSession<'a> {
    pub(crate) session_id: &'a str,
    pub(crate) workspace_id: &'a str,
    pub(crate) runner_principal: &'a str,
    pub(crate) runner_instance: &'a str,
    pub(crate) channel_epoch: &'a str,
    pub(crate) host_instance_id: &'a str,
    pub(crate) terminal_epoch: &'a str,
}

pub(crate) fn parse_exact_hmux_session(
    source: &[u8],
    expected: &ExpectedHmuxSession<'_>,
) -> Result<HmuxSessionInspection, HmuxSessionInspectionFailure> {
    parse_exact_hmux_session_with_lifecycle(source, expected, false)
}

pub(crate) fn parse_exact_hmux_session_for_transition(
    source: &[u8],
    expected: &ExpectedHmuxSession<'_>,
) -> Result<HmuxSessionInspection, HmuxSessionInspectionFailure> {
    parse_exact_hmux_session_with_lifecycle(source, expected, true)
}

fn parse_exact_hmux_session_with_lifecycle(
    source: &[u8],
    expected: &ExpectedHmuxSession<'_>,
    allow_exited: bool,
) -> Result<HmuxSessionInspection, HmuxSessionInspectionFailure> {
    let session: HmuxSessionInspection = serde_json::from_slice(source)
        .map_err(|_| HmuxSessionInspectionFailure::DescriptorMalformed)?;
    let exact_lifecycle = (session.lifecycle == "ready" && session.health == "healthy")
        || (allow_exited && session.lifecycle == "exited" && session.health == "exited");
    if session.schema_version != 1
        || session.session_id != expected.session_id
        || session.workspace_id != expected.workspace_id
        || session.session_class != "managed"
        || session.runner_principal != expected.runner_principal
        || session.runner_instance != expected.runner_instance
        || session.channel_epoch != expected.channel_epoch
        || session.host_instance_id != expected.host_instance_id
        || session.terminal_epoch != expected.terminal_epoch
        || (allow_exited && canonical_u64(&session.output_seq).is_none())
    {
        return Err(HmuxSessionInspectionFailure::DescriptorMismatch);
    }
    if !exact_lifecycle {
        // A stale transport cannot prove that an in-flight stop retained its
        // provider. Keep observation failure separate from identity mismatch.
        return Err(HmuxSessionInspectionFailure::DescriptorUnavailable);
    }
    if session.agent_runtime_state.as_ref().is_some_and(|state| {
        let output_seq = canonical_u64(&session.output_seq);
        state.terminal_epoch != session.terminal_epoch
            || canonical_positive_u64(&state.revision).is_none()
            || canonical_u64(&state.turn_completed_count).is_none()
            || canonical_u64(&state.observed_through_output_seq)
                .zip(output_seq)
                .is_none_or(|(observed, output)| observed > output)
            || match state.attention {
                AgentRuntimeAttention::None => state.attention_id.is_some(),
                _ => state
                    .attention_id
                    .as_deref()
                    .is_none_or(|id| !valid_token(id)),
            }
    }) {
        return Err(HmuxSessionInspectionFailure::AgentRuntimeStateMismatch);
    }
    if session
        .provider_conversation_identity
        .as_ref()
        .is_some_and(|identity| {
            identity.session_id != session.session_id
                || identity.workspace_id != session.workspace_id
                || identity.runner_principal != session.runner_principal
                || identity.runner_instance != session.runner_instance
                || identity.channel_epoch != session.channel_epoch
                || identity.host_instance_id != session.host_instance_id
                || identity.terminal_epoch != session.terminal_epoch
                || identity.provider_id != session.provider_id
                || !valid_token(&identity.conversation_id)
        })
    {
        return Err(HmuxSessionInspectionFailure::ProviderConversationIdentityMismatch);
    }
    Ok(session)
}

fn valid_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'/' | b'-')
        })
}

fn canonical_u64(value: &str) -> Option<u64> {
    let parsed = value.parse::<u64>().ok()?;
    (parsed.to_string() == value).then_some(parsed)
}

fn canonical_positive_u64(value: &str) -> Option<u64> {
    canonical_u64(value).filter(|value| *value > 0)
}

fn zero_u64_string() -> String {
    "0".into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn inspection() -> serde_json::Value {
        json!({
            "schema_version": 1,
            "session_id": "session-1",
            "workspace_id": "workspace-1",
            "session_class": "managed",
            "lifecycle": "ready",
            "provider_id": "claude",
            "runner_principal": "runner-principal-1",
            "runner_instance": "runner-instance-1",
            "channel_epoch": "1",
            "host_instance_id": "host-instance-1",
            "terminal_epoch": "terminal-epoch-1",
            "output_seq": "9",
            "health": "healthy",
            "agentRuntimeState": {
                "terminal_epoch": "terminal-epoch-1",
                "revision": "3",
                "observed_through_output_seq": "9",
                "lifecycle": "running",
                "activity": "waiting",
                "attention": "none",
                "attention_id": null,
                "source": "provider_event",
                "turn_completed_count": "1"
            },
            "providerConversationIdentity": {
                "session_id": "session-1",
                "workspace_id": "workspace-1",
                "runner_principal": "runner-principal-1",
                "runner_instance": "runner-instance-1",
                "channel_epoch": "1",
                "host_instance_id": "host-instance-1",
                "terminal_epoch": "terminal-epoch-1",
                "revision": "1",
                "observed_through_output_seq": "9",
                "provider_id": "claude",
                "conversation_id": "conversation-1",
                "source": "provider_event"
            }
        })
    }

    fn expected() -> ExpectedHmuxSession<'static> {
        ExpectedHmuxSession {
            session_id: "session-1",
            workspace_id: "workspace-1",
            runner_principal: "runner-principal-1",
            runner_instance: "runner-instance-1",
            channel_epoch: "1",
            host_instance_id: "host-instance-1",
            terminal_epoch: "terminal-epoch-1",
        }
    }

    #[test]
    fn semantic_idle_age_is_capability_fenced_without_breaking_ordinary_inspection() {
        for value in [
            json!(null),
            json!(1),
            json!(true),
            json!({}),
            json!("01"),
            json!("-1"),
            json!("18446744073709551616"),
            json!("1000 "),
        ] {
            for capable in [false, true] {
                let mut observed = inspection();
                observed["semanticIdleMs"] = value.clone();
                observed["controllerInputPending"] = json!(false);
                if capable {
                    observed["capabilities"] =
                        json!([hmux_session_protocol::SEMANTIC_IDLE_OBSERVATION_CAPABILITY]);
                }
                let parsed =
                    parse_exact_hmux_session(&serde_json::to_vec(&observed).unwrap(), &expected())
                        .unwrap();
                assert!(parsed.is_agent_quiescent());
                assert!(parsed.managed_stop_quiescence_fence().is_ok());
                assert_eq!(
                    parsed.semantic_idle_age(),
                    if capable {
                        Err("hmux_semantic_idle_observation_unavailable")
                    } else {
                        Ok(None)
                    }
                );
            }
        }
        let mut observed = inspection();
        observed["capabilities"] =
            json!([hmux_session_protocol::SEMANTIC_IDLE_OBSERVATION_CAPABILITY]);
        observed["controllerInputPending"] = json!(false);
        let parse = |value: &serde_json::Value| {
            parse_exact_hmux_session(&serde_json::to_vec(value).unwrap(), &expected()).unwrap()
        };
        assert_eq!(
            parse(&observed).semantic_idle_age(),
            Err("hmux_semantic_idle_observation_unavailable")
        );
        for age in [0, 86_400_000, u64::MAX] {
            observed["semanticIdleMs"] = json!(age.to_string());
            assert_eq!(
                parse(&observed).semantic_idle_age(),
                Ok(Some(Duration::from_millis(age)))
            );
        }
        observed["controllerInputPending"] = json!(null);
        assert_eq!(
            parse(&observed).semantic_idle_age(),
            Err("hmux_semantic_idle_observation_unavailable")
        );
        observed["controllerInputPending"] = json!(true);
        assert_eq!(
            parse(&observed).semantic_idle_age(),
            Err("hmux_controller_input_pending")
        );
        observed["controllerInputPending"] = json!(false);
        observed["agentRuntimeState"]["activity"] = json!("working");
        assert_eq!(
            parse(&observed).semantic_idle_age(),
            Err("hmux_agent_runtime_not_quiescent")
        );
    }

    #[test]
    fn pending_input_protects_a_waiting_provider_without_fabricating_legacy_evidence() {
        for pending in [None, Some(false), Some(true)] {
            let mut observed = inspection();
            if let Some(pending) = pending {
                observed["controllerInputPending"] = json!(pending);
            }
            let parsed =
                parse_exact_hmux_session(&serde_json::to_vec(&observed).unwrap(), &expected())
                    .unwrap();
            assert!(
                parsed.is_agent_quiescent(),
                "input is not provider activity"
            );
            assert_eq!(parsed.controller_input_pending, pending);
            let result = parsed.managed_stop_quiescence_fence();
            if pending == Some(true) {
                assert_eq!(result.unwrap_err(), "hmux_controller_input_pending");
            } else {
                assert_eq!(result.unwrap().observed_through_output_seq(), 9);
            }
        }
    }

    #[test]
    fn semantic_idle_guarantee_requires_the_exact_hosts_additive_capability() {
        for (capabilities, supported) in [
            (vec![], false),
            (
                vec![hmux_session_protocol::MANAGED_PROVIDER_QUIESCENT_STOP_CAPABILITY],
                false,
            ),
            (
                vec![hmux_session_protocol::MANAGED_PROVIDER_SEMANTIC_QUIESCENT_STOP_CAPABILITY],
                true,
            ),
        ] {
            let mut observed = inspection();
            observed["capabilities"] = json!(capabilities);
            let parsed =
                parse_exact_hmux_session(&serde_json::to_vec(&observed).unwrap(), &expected())
                    .unwrap();
            assert!(
                parsed.is_agent_quiescent(),
                "ordinary observation remains available"
            );
            assert_eq!(parsed.supports_semantic_quiescent_stop(), supported);
        }
    }

    #[test]
    fn exact_handshake_projects_the_provider_conversation_identity() {
        let parsed =
            parse_exact_hmux_session(&serde_json::to_vec(&inspection()).unwrap(), &expected())
                .unwrap();
        assert_eq!(
            parsed
                .provider_conversation_identity
                .as_ref()
                .unwrap()
                .conversation_id,
            "conversation-1"
        );
        assert_eq!(parsed.turn_completed_count(), Some(1));
        assert!(parsed.is_agent_quiescent());
    }

    #[test]
    fn runtime_completion_count_defaults_to_zero_and_rejects_noncanonical_values() {
        let mut fresh = inspection();
        fresh["agentRuntimeState"]
            .as_object_mut()
            .unwrap()
            .remove("turn_completed_count");
        let parsed =
            parse_exact_hmux_session(&serde_json::to_vec(&fresh).unwrap(), &expected()).unwrap();
        assert_eq!(parsed.turn_completed_count(), Some(0));

        fresh["agentRuntimeState"]["turn_completed_count"] = json!("01");
        assert_eq!(
            parse_exact_hmux_session(&serde_json::to_vec(&fresh).unwrap(), &expected())
                .unwrap_err(),
            HmuxSessionInspectionFailure::AgentRuntimeStateMismatch
        );
    }

    #[test]
    fn conversation_identity_from_another_generation_fails_closed() {
        let mut stale = inspection();
        stale["providerConversationIdentity"]["host_instance_id"] = json!("other-host");
        assert_eq!(
            parse_exact_hmux_session(&serde_json::to_vec(&stale).unwrap(), &expected())
                .unwrap_err(),
            HmuxSessionInspectionFailure::ProviderConversationIdentityMismatch
        );
    }

    #[test]
    fn runtime_state_ahead_of_the_exact_snapshot_fails_closed() {
        let mut future = inspection();
        future["agentRuntimeState"]["observed_through_output_seq"] = json!("10");
        assert_eq!(
            parse_exact_hmux_session(&serde_json::to_vec(&future).unwrap(), &expected())
                .unwrap_err(),
            HmuxSessionInspectionFailure::AgentRuntimeStateMismatch
        );
    }

    #[test]
    fn exact_stale_transport_is_unavailable_not_an_identity_mismatch() {
        let mut stale = inspection();
        stale["health"] = json!("stale_transport");
        stale["output_seq"] = json!("0");
        stale["agentRuntimeState"] = serde_json::Value::Null;
        stale["providerConversationIdentity"] = serde_json::Value::Null;
        let bytes = serde_json::to_vec(&stale).unwrap();

        for result in [
            parse_exact_hmux_session(&bytes, &expected()),
            parse_exact_hmux_session_for_transition(&bytes, &expected()),
        ] {
            let failure = result.unwrap_err();
            assert_eq!(failure, HmuxSessionInspectionFailure::DescriptorUnavailable);
            assert!(!failure.proves_identity_mismatch());
        }

        stale["host_instance_id"] = json!("different-host");
        assert_eq!(
            parse_exact_hmux_session_for_transition(
                &serde_json::to_vec(&stale).unwrap(),
                &expected(),
            )
            .unwrap_err(),
            HmuxSessionInspectionFailure::DescriptorMismatch,
        );
    }

    #[test]
    fn transition_inspection_accepts_only_the_exact_exited_tombstone() {
        let mut exited = inspection();
        exited["lifecycle"] = json!("exited");
        exited["health"] = json!("exited");
        exited["agentRuntimeState"] = serde_json::Value::Null;
        exited["providerConversationIdentity"] = serde_json::Value::Null;
        let bytes = serde_json::to_vec(&exited).unwrap();

        assert_eq!(
            parse_exact_hmux_session(&bytes, &expected()).unwrap_err(),
            HmuxSessionInspectionFailure::DescriptorUnavailable
        );
        assert!(
            parse_exact_hmux_session_for_transition(&bytes, &expected())
                .unwrap()
                .is_exited_exact()
        );
    }

    #[test]
    fn quiescence_fence_uses_the_same_exact_handshake_projection() {
        let parsed =
            parse_exact_hmux_session(&serde_json::to_vec(&inspection()).unwrap(), &expected())
                .unwrap();
        let fence = parsed.managed_stop_quiescence_fence().unwrap();
        assert_eq!(fence.terminal_epoch(), "terminal-epoch-1");
        assert_eq!(fence.runtime_revision(), 3);
        assert_eq!(fence.observed_through_output_seq(), 9);
    }

    #[test]
    fn exact_inspection_pairs_waiting_revision_with_current_output_high_water() {
        let mut advanced = inspection();
        advanced["output_seq"] = json!("10");
        let parsed =
            parse_exact_hmux_session(&serde_json::to_vec(&advanced).unwrap(), &expected()).unwrap();

        assert!(parsed.is_agent_quiescent());
        let fence = parsed.managed_stop_quiescence_fence().unwrap();
        assert_eq!(fence.runtime_revision(), 3);
        assert_eq!(fence.observed_through_output_seq(), 10);
    }

    #[test]
    fn ordinary_probe_preserves_pre_observation_snapshot_compatibility() {
        let mut legacy = inspection();
        legacy.as_object_mut().unwrap().remove("output_seq");
        legacy.as_object_mut().unwrap().remove("agentRuntimeState");
        legacy
            .as_object_mut()
            .unwrap()
            .remove("providerConversationIdentity");
        let bytes = serde_json::to_vec(&legacy).unwrap();

        assert!(parse_exact_hmux_session(&bytes, &expected()).is_ok());
        assert_eq!(
            parse_exact_hmux_session_for_transition(&bytes, &expected()).unwrap_err(),
            HmuxSessionInspectionFailure::DescriptorMismatch
        );
    }

    #[test]
    fn malformed_or_mismatched_descriptors_are_identity_failures_not_transport_failures() {
        assert_eq!(
            parse_exact_hmux_session(b"not-json", &expected()).unwrap_err(),
            HmuxSessionInspectionFailure::DescriptorMalformed
        );
        assert!(HmuxSessionInspectionFailure::DescriptorMalformed.proves_identity_mismatch());
        assert!(HmuxSessionInspectionFailure::DescriptorMismatch.proves_identity_mismatch());
        assert!(!HmuxSessionInspectionFailure::DescriptorUnavailable.proves_identity_mismatch());
        assert!(!HmuxSessionInspectionFailure::DescriptorTimeout.proves_identity_mismatch());
    }
}
