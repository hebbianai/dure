//! Optional session-idle admission inside the existing backend lifetime.
//! This observes policy eligibility; Hmux remains the destructive authority.

use std::sync::Arc;
use std::time::Duration;

use dure_app::{
    AgentIdV1, AgentProviderConversationPlanV1, AgentRuntimeBindingAuthorityV1, DomainStore,
};
use serde::Serialize;
use tokio::sync::Mutex;

use super::{HibernateBodyV1, ObservedIdleV1, hibernate, idle_checkpoint, idle_policy};
use crate::ServiceState;
use crate::agent_runtime_projection::{AgentRuntimeObservedV1, read_locked};
use crate::agent_runtime_transition_apply::{
    inspect_native_source, runtime_operation_identity, store_error, validate_source_observation,
};

const POLICY_ENV: &str = "DURE_SESSION_IDLE_AFTER_MS";
const SCAN_INTERVAL: Duration = Duration::from_secs(15);

// Selection, full native authority and semantic activity define one idle epoch.
// Output high-water fences each stop attempt, but never resets the idle clock.
type IdleSource = (i64, AgentRuntimeBindingAuthorityV1, u64);

pub(crate) fn native_idle_attempt(
    body: &HibernateBodyV1,
    policy_revision: Option<u64>,
    after: Duration,
    elapsed: Duration,
) -> Result<Option<String>, String> {
    let interval = elapsed
        .as_millis()
        .checked_div(after.as_millis())
        .ok_or_else(|| "runtime_idle_policy_unavailable".to_owned())?;
    if interval == 0 {
        return Ok(None);
    }
    let revision = policy_revision.ok_or_else(|| "runtime_idle_policy_unavailable".to_owned())?;
    body.expected_idle
        .as_ref()
        .ok_or("runtime_idle_source_unavailable")?;
    let request =
        serde_json::to_vec(body).map_err(|_| "runtime_idle_source_unavailable".to_owned())?;
    // Replays keep the exact request across backend lifetimes. A fresh stop
    // fence after a confirmed refusal is a new request, not a conflicting replay.
    // Including output here does not change the semantic idle eligibility clock.
    runtime_operation_identity(
        b"dure-native-semantic-idle-attempt/v2\0",
        &[
            &request,
            &revision.to_be_bytes(),
            &after.as_millis().to_be_bytes(),
            &interval.to_be_bytes(),
        ],
    )
    .map(|(_, attempt)| Some(attempt))
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IdleStatus {
    schema_version: u16,
    configuration: &'static str,
    after_ms: Option<u64>,
    policy_revision: Option<u64>,
    observed_at_ms: Option<i64>,
    /// Each receipt describes a bounded page, not a complete session census.
    partial: bool,
    reason_code: Option<String>,
    agents: Vec<AgentIdleObservation>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentIdleObservation {
    agent_id: AgentIdV1,
    state: &'static str,
    observed_idle_ms: Option<u64>,
    reason_code: Option<String>,
    clock_source: Option<&'static str>,
    restored_from_checkpoint: bool,
}

pub(crate) struct IdleRuntime {
    seed: Result<idle_policy::Policy, &'static str>,
    // A disable receipt waits for admitted work; observation never waits for a stop.
    admission: Mutex<()>,
    status: Mutex<IdleStatus>,
}

#[derive(Serialize)]
pub(crate) struct IdleInspection {
    #[serde(flatten)]
    status: IdleStatus,
    reclamation: super::reclamation::ReclamationObservation,
}

impl Default for IdleRuntime {
    fn default() -> Self {
        Self::from_value(None)
    }
}

impl IdleStatus {
    fn from_policy(policy: Result<idle_policy::Record, &'static str>) -> Self {
        let (configuration, after_ms, revision, reason) = match policy {
            Ok(record) => (
                if record.policy.after_ms().is_some() {
                    "enabled"
                } else {
                    "disabled"
                },
                record.policy.after_ms(),
                Some(record.revision),
                None,
            ),
            Err(reason) => ("invalid", None, None, Some(reason.to_owned())),
        };
        Self {
            schema_version: 1,
            configuration,
            after_ms,
            policy_revision: revision,
            observed_at_ms: None,
            partial: false,
            reason_code: reason,
            agents: Vec::new(),
        }
    }

    fn same_policy(&self, other: &Self) -> bool {
        self.policy_revision == other.policy_revision
            && self.configuration == other.configuration
            && self.after_ms == other.after_ms
    }
}

fn policy_error(error: crate::ControlPlaneError) -> &'static str {
    match error {
        crate::ControlPlaneError::Invalid(code) if code.starts_with("runtime_idle_") => code,
        _ => "runtime_idle_policy_unavailable",
    }
}

impl IdleRuntime {
    pub(crate) fn from_environment() -> Self {
        let value = std::env::var_os(POLICY_ENV);
        Self::from_value(value.as_ref().map(|value| value.to_str().unwrap_or("")))
    }

    pub(crate) fn from_value(value: Option<&str>) -> Self {
        let seed = idle_policy::Policy::from_environment_value(value);
        let mut status = IdleStatus::from_policy(seed.map(|_| idle_policy::Record::default()));
        if let Ok(policy) = seed {
            status.after_ms = policy.after_ms();
            if status.after_ms.is_some() {
                status.configuration = "enabled";
            }
        }
        Self {
            seed,
            admission: Mutex::new(()),
            status: Mutex::new(status),
        }
    }

    fn refresh(&self, state: &ServiceState, status: &mut IdleStatus) {
        let current =
            IdleStatus::from_policy(idle_policy::load(state, self.seed).map_err(policy_error));
        if !status.same_policy(&current) {
            *status = current;
        }
    }

    pub(crate) async fn observe(&self, state: &ServiceState) -> IdleStatus {
        let mut status = self.status.lock().await;
        self.refresh(state, &mut status);
        status.clone()
    }

    pub(crate) async fn inspect_with_outcomes(&self, state: &ServiceState) -> IdleInspection {
        // Do not hold the policy lock across journal I/O or join the scheduler.
        // Disabled policies still expose previous stop/wake outcomes.
        IdleInspection {
            status: self.observe(state).await,
            reclamation: super::reclamation::observe(state).await,
        }
    }

    pub(crate) async fn configure(
        &self,
        state: &ServiceState,
        body: idle_policy::ConfigureBody,
    ) -> Result<IdleStatus, crate::BackendDispatchError> {
        let _admission = self.admission.lock().await;
        let record = idle_policy::configure(state, body).map_err(policy_error)?;
        let mut status = self.status.lock().await;
        *status = IdleStatus::from_policy(Ok(record));
        Ok(status.clone())
    }

    #[cfg(test)]
    pub(crate) async fn inspect(&self) -> IdleStatus {
        self.status.lock().await.clone()
    }

    async fn publish(&self, state: &ServiceState, observation: IdleStatus) {
        let mut status = self.status.lock().await;
        self.refresh(state, &mut status);
        // A completed old-policy census cannot overwrite a concurrent configure.
        if status.same_policy(&observation) {
            *status = observation;
        }
    }
}

pub(crate) async fn run(state: Arc<ServiceState>) {
    let mut windows: Option<Result<idle_checkpoint::Windows, String>> = None;
    let mut policy_revision = None;
    let mut cursor = None;
    let mut timer = tokio::time::interval(SCAN_INTERVAL);
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        timer.tick().await;
        let mut status = state.runtime_idle.observe(&state).await;
        if policy_revision != status.policy_revision || status.after_ms.is_none() {
            windows = None;
            cursor = None;
            policy_revision = status.policy_revision;
        }
        let Some(after) = status.after_ms.map(Duration::from_millis) else {
            continue;
        };
        status.agents.clear();
        status.observed_at_ms = crate::now_ms().ok();
        status.reason_code = None;
        status.partial = false;
        if !state.is_mutation_authority() {
            windows = None;
            cursor = None;
            status.reason_code = Some("runtime_idle_authority_unavailable".into());
            state.runtime_idle.publish(&state, status).await;
            continue;
        }
        let legacy = windows.get_or_insert_with(|| {
            idle_checkpoint::Windows::load(
                &state,
                status.policy_revision.unwrap_or_default(),
                status.after_ms.unwrap_or_default(),
            )
        });
        if let Ok(legacy) = legacy
            && let Err(error) = legacy.disarm(&state)
        {
            windows = Some(Err(error));
        }
        let candidates = match state
            .store
            .agent_runtime_native_candidates(cursor.as_ref())
            .await
        {
            Ok(candidates) => candidates,
            Err(_) => {
                windows = None;
                cursor = None;
                status.reason_code = Some("runtime_idle_candidates_unavailable".into());
                state.runtime_idle.publish(&state, status).await;
                continue;
            }
        };
        status.partial = cursor.is_some() || candidates.len() == 64;
        cursor = if candidates.len() == 64 {
            candidates.last().cloned()
        } else {
            None
        };
        for agent_id in candidates {
            let key = agent_id.as_str().to_owned();
            let (source, body, native_age) = match capture(&state, &agent_id).await {
                Ok(source) => source,
                Err(reason) => {
                    if let Some(Ok(windows)) = windows.as_mut() {
                        windows.forget(&key);
                    }
                    status.agents.push(AgentIdleObservation {
                        agent_id,
                        state: "protected",
                        observed_idle_ms: None,
                        reason_code: Some(reason),
                        clock_source: None,
                        restored_from_checkpoint: false,
                    });
                    continue;
                }
            };
            let mut restored = false;
            let (elapsed, ready) = if let Some(elapsed) = native_age {
                if let Some(Ok(windows)) = windows.as_mut() {
                    windows.forget(&key);
                }
                (
                    elapsed,
                    native_idle_attempt(&body, status.policy_revision, after, elapsed)
                        .map(|attempt| attempt.map(|attempt| (attempt, body))),
                )
            } else {
                let observed = match windows.as_mut() {
                    Some(Ok(windows)) => legacy_source_key(&source)
                        .and_then(|source| windows.observe(&key, source, body)),
                    Some(Err(error)) => Err(error.clone()),
                    None => Err("runtime_idle_checkpoint_unavailable".into()),
                };
                match observed {
                    Ok((elapsed, was_restored, ready)) => {
                        restored = was_restored;
                        let ready = ready
                            .map(|body| {
                                // The previous scan was disarmed before this probe.
                                // Keep the record disarmed until the complete page is
                                // inspected; do not re-publish unvalidated old entries.
                                windows
                                    .as_ref()
                                    .and_then(|windows| windows.as_ref().ok())
                                    .ok_or("runtime_idle_checkpoint_unavailable")?
                                    .disarm(&state)?;
                                crate::random_generation()
                                    .map(|attempt| (format!("runtime-idle-{attempt}"), body))
                                    .map_err(|_| "runtime_idle_authority_unavailable".to_owned())
                            })
                            .transpose();
                        (elapsed, ready)
                    }
                    Err(reason) => (Duration::ZERO, Err(reason)),
                }
            };
            let mut observation = AgentIdleObservation {
                agent_id,
                state: "observing",
                observed_idle_ms: u64::try_from(elapsed.as_millis()).ok(),
                reason_code: None,
                clock_source: Some(if native_age.is_some() {
                    "host"
                } else {
                    "backend_observed"
                }),
                restored_from_checkpoint: restored,
            };
            let ready = match ready {
                Ok(ready) => ready,
                Err(reason) => {
                    observation.state = "protected";
                    observation.observed_idle_ms = None;
                    observation.reason_code = Some(reason);
                    None
                }
            };
            if let Some((attempt, body)) = ready {
                observation.state = "protected";
                let _admission = state.runtime_idle.admission.lock().await;
                let current = state.runtime_idle.observe(&state).await;
                if !status.same_policy(&current) {
                    windows = None;
                    cursor = None;
                    break;
                }
                // Native intervals reuse the journal's exact attempt. Legacy
                // sampled intervals are consumed even when admission refuses.
                let result = if state.is_mutation_authority() {
                    hibernate(&state, &attempt, body).await
                } else {
                    Err("runtime_idle_authority_unavailable".into())
                };
                match result {
                    Ok(_) => observation.state = "hibernate_requested",
                    Err(error) => observation.reason_code = Some(error.code),
                }
            }
            status.agents.push(observation);
        }
        if let Some(Ok(legacy)) = windows.as_ref()
            && let Err(error) = legacy.save(&state)
        {
            status.reason_code = Some(error.clone());
            windows = Some(Err(error));
        }
        state.runtime_idle.publish(&state, status).await;
    }
}

fn legacy_source_key(source: &IdleSource) -> Result<String, String> {
    let encoded = serde_json::to_vec(
        &serde_json::to_value(source).map_err(|_| "runtime_idle_source_unavailable")?,
    )
    .map_err(|_| "runtime_idle_source_unavailable")?;
    runtime_operation_identity(b"dure-legacy-idle-observation/v1\0", &[&encoded])
        .map(|(_, key)| key)
}

async fn capture(
    state: &ServiceState,
    agent_id: &AgentIdV1,
) -> Result<(IdleSource, HibernateBodyV1, Option<Duration>), String> {
    let _guard = tokio::time::timeout(
        Duration::from_secs(1),
        state.agent_operations.acquire(agent_id),
    )
    .await
    .map_err(|_| "runtime_idle_agent_busy".to_owned())?;
    if !state.is_mutation_authority() {
        return Err("runtime_idle_authority_unavailable".into());
    }
    let AgentRuntimeObservedV1::Stable {
        mut selection,
        mut authority,
    } = read_locked(state, agent_id).await?
    else {
        return Err("runtime_idle_source_not_stable".into());
    };
    let AgentRuntimeBindingAuthorityV1::NativeCli { authority: native } = authority.as_mut() else {
        return Err("runtime_idle_source_unsupported".into());
    };
    let inspected = inspect_native_source(state, &selection, native).await;
    // Healthy sessions retain the existing hot path. A retired or missing
    // descriptor needs durable successor publication before idle observation.
    let needs_publication = match &inspected {
        Ok(inspection) => inspection.is_exited_exact(),
        Err(crate::HmuxSessionInspectionFailure::DescriptorUnavailable) => true,
        Err(_) => false,
    };
    let inspection = if needs_publication
        && crate::agent_runtime_native_rehost::request::publish_completed_successor_locked(
            state, &selection, native,
        )
        .await
        .map_err(|error| error.code)?
    {
        let AgentRuntimeObservedV1::Stable {
            selection: published_selection,
            authority: published_authority,
        } = read_locked(state, agent_id).await?
        else {
            return Err("runtime_idle_source_not_stable".into());
        };
        selection = published_selection;
        authority = published_authority;
        let AgentRuntimeBindingAuthorityV1::NativeCli { authority: native } = authority.as_ref()
        else {
            return Err("runtime_idle_source_unsupported".into());
        };
        inspect_native_source(state, &selection, native).await
    } else {
        inspected
    }
    .map_err(|error| error.code().to_owned())?;
    let AgentRuntimeBindingAuthorityV1::NativeCli { authority: native } = authority.as_mut() else {
        return Err("runtime_idle_source_unsupported".into());
    };
    let conversation_id = native
        .binding
        .provider_conversation_id
        .clone()
        .or_else(|| {
            inspection
                .provider_conversation_identity
                .as_ref()
                .map(|identity| identity.conversation_id.clone())
        })
        .ok_or_else(|| "agent_runtime_provider_conversation_unavailable".to_owned())?;
    let conversation = AgentProviderConversationPlanV1::from_option(Some(conversation_id.clone()))
        .map_err(|_| "agent_runtime_provider_conversation_unavailable".to_owned())?;
    validate_source_observation(&selection, &conversation, &inspection)
        .map_err(|error| error.admission_error().code)?;
    if native.binding.provider_conversation_id.is_none() {
        if !state.is_mutation_authority() {
            return Err("runtime_idle_authority_unavailable".into());
        }
        // Share binding.ensure's exact missing-to-known convergence. A pane
        // need not be mounted to retain the identity learned by its Host.
        *native = state
            .store
            .converge_agent_checkpoint_provider_conversation(native, &conversation_id)
            .await
            .map_err(store_error)?;
    }
    if !inspection.supports_semantic_quiescent_stop() {
        return Err("agent_runtime_semantic_idle_unavailable".into());
    }
    let fence = inspection
        .managed_stop_quiescence_fence()
        .map_err(str::to_owned)?;
    let native_age = inspection.semantic_idle_age().map_err(str::to_owned)?;
    Ok((
        (
            selection.revision,
            authority.as_ref().clone(),
            fence.runtime_revision(),
        ),
        HibernateBodyV1 {
            schema_version: 1,
            agent_id: agent_id.clone(),
            expected_source_revision: selection.revision,
            expected_idle: Some(ObservedIdleV1 {
                source_authority: *authority,
                runtime_revision: fence.runtime_revision(),
                observed_through_output_seq: fence.observed_through_output_seq(),
            }),
        },
        native_age,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_idle_attempt_survives_restart_and_is_scoped_to_policy_source_and_interval() {
        use dure_app::{
            AgentCheckpointBindingAuthorityV1, RuntimeKindIdV1, SessionBindingRecordV1,
        };
        let agent = AgentIdV1::new("idle-agent").unwrap();
        let source = (
            3,
            AgentRuntimeBindingAuthorityV1::NativeCli {
                authority: AgentCheckpointBindingAuthorityV1 {
                    schema_version: 1,
                    binding: SessionBindingRecordV1 {
                        agent_id: agent.clone(),
                        runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
                        session_id: "session-1".into(),
                        provider_conversation_id: Some("conversation-1".into()),
                        credential_reference_id: None,
                        binding_generation: 1,
                        bound_at_ms: 10,
                    },
                    runtime_workspace_id: "workspace-1".into(),
                    runner_principal: "principal-1".into(),
                    runner_instance: "instance-1".into(),
                    channel_epoch: "1".into(),
                    host_instance_id: "host-1".into(),
                    terminal_epoch: "terminal-1".into(),
                    updated_at_ms: 10,
                },
            },
            7,
        );
        let threshold = Duration::from_secs(60);
        let body = |source: &IdleSource| HibernateBodyV1 {
            schema_version: 1,
            agent_id: agent.clone(),
            expected_source_revision: source.0,
            expected_idle: Some(ObservedIdleV1 {
                source_authority: source.1.clone(),
                runtime_revision: source.2,
                observed_through_output_seq: 1,
            }),
        };
        let attempt = |source: &IdleSource, policy, seconds| {
            native_idle_attempt(
                &body(source),
                policy,
                threshold,
                Duration::from_secs(seconds),
            )
            .unwrap()
        };
        assert_eq!(attempt(&source, Some(2), 59), None);
        let first = attempt(&source, Some(2), 60).unwrap();
        let mut fresh_fence = body(&source);
        fresh_fence
            .expected_idle
            .as_mut()
            .unwrap()
            .observed_through_output_seq += 1;
        assert_ne!(
            native_idle_attempt(&fresh_fence, Some(2), threshold, Duration::from_secs(90)).unwrap(),
            Some(first.clone()),
            "fresh output after a retained stop needs a distinct exact request without resetting semantic idle age"
        );
        let restored = serde_json::from_slice(&serde_json::to_vec(&source).unwrap()).unwrap();
        assert_eq!(
            attempt(&restored, Some(2), 90),
            Some(first.clone()),
            "no backend-local clock or random generation enters a native attempt"
        );
        assert_ne!(attempt(&source, Some(2), 120), Some(first.clone()));
        assert_ne!(attempt(&source, Some(3), 90), Some(first.clone()));
        let mut changed = source.clone();
        changed.0 += 1;
        assert_ne!(attempt(&changed, Some(2), 90), Some(first.clone()));
        changed = source.clone();
        changed.2 += 1;
        assert_ne!(attempt(&changed, Some(2), 90), Some(first.clone()));
        changed = source.clone();
        let AgentRuntimeBindingAuthorityV1::NativeCli { authority } = &mut changed.1 else {
            unreachable!()
        };
        authority.host_instance_id = "host-2".into();
        assert_ne!(attempt(&changed, Some(2), 90), Some(first));
        assert!(native_idle_attempt(&body(&source), None, threshold, threshold).is_err());
        assert!(native_idle_attempt(&body(&source), Some(2), Duration::ZERO, threshold).is_err());
    }

    #[tokio::test]
    async fn policy_requires_explicit_bounded_configuration() {
        assert_eq!(
            IdleRuntime::default().inspect().await.configuration,
            "disabled"
        );
        for value in [
            "",
            "0",
            "999",
            "-1",
            "1000 ",
            "01000",
            "2592000001",
            "18446744073709551616",
        ] {
            let policy = IdleRuntime::from_value(Some(value));
            assert!(policy.inspect().await.after_ms.is_none());
            assert_eq!(policy.inspect().await.configuration, "invalid");
        }
        let policy = IdleRuntime::from_value(Some("1800000"));
        let status = policy.inspect().await;
        assert_eq!(status.configuration, "enabled");
        assert_eq!(status.after_ms, Some(1_800_000));
        assert_eq!(
            status.observed_at_ms, None,
            "configuration is not observation evidence"
        );
    }
}
