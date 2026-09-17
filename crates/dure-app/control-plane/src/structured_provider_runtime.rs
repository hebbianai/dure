use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use dure_app::{
    AgentExecutionProfileV1, AgentIdV1, AgentInteractionBindingV1, AgentRuntimeBindingAuthorityV1,
    AgentRuntimeReplacementAuthorityV1, AgentRuntimeSelectionV1, AgentRuntimeTransitionRecordV1,
    AgentSpawnEffortSelectionV1, AgentSpawnModelSelectionV1, ProviderIdV1,
    ProviderPermissionModeV1,
};

use crate::claude_structured_runtime::{
    ClaudeStructuredOpenRequestV1, ClaudeStructuredRuntimeErrorV1, ClaudeStructuredRuntimeManager,
};
use dure_app_sqlite::SqliteDomainStore;
use hmux_client::ProviderStateEnvironment;

#[derive(Clone, Debug)]
pub(crate) struct StructuredProviderOpenRequestV1 {
    pub agent_id: AgentIdV1,
    pub execution_profile: AgentExecutionProfileV1,
    pub provider_conversation_ref: Option<String>,
    pub permission_mode: ProviderPermissionModeV1,
    pub model: Option<AgentSpawnModelSelectionV1>,
    pub effort: Option<AgentSpawnEffortSelectionV1>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum StructuredProviderRuntimeErrorKindV1 {
    RequestInvalid,
    RuntimeUnavailable,
    CredentialUnavailable,
    CredentialStale,
    SourceBusy,
    RuntimeConflict,
    LaunchFailed,
    /// Durable provider state is quiescent until an explicit mutation advances it.
    ExplicitRecoveryRequired,
    StopFailed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum StructuredProviderTargetQuiescenceV1 {
    /// The adapter cannot prove whether a target effect escaped. The
    /// coordinator may retry recovery, but must not advertise RepairRequired
    /// or zero-effect close from this observation.
    Unknown,
    /// The failed attempt performed no target mutation. Any replacement
    /// authority already owned by the transition remains authoritative.
    NoTarget,
    /// The adapter durably cleaned this exact published binding. It is dormant
    /// lineage for one explicit repair/supersede, not a live process handle.
    ExactFailedBinding(Box<AgentInteractionBindingV1>),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct StructuredProviderRuntimeErrorV1 {
    pub kind: StructuredProviderRuntimeErrorKindV1,
    pub code: String,
    pub target_quiescence: StructuredProviderTargetQuiescenceV1,
    /// Evidence behind `code`, carried from the provider runtime so a failed
    /// spawn can say why rather than only which code. Never matched on.
    pub detail: Option<String>,
}

impl StructuredProviderRuntimeErrorV1 {
    pub(crate) fn new(kind: StructuredProviderRuntimeErrorKindV1, code: impl Into<String>) -> Self {
        Self {
            kind,
            code: code.into(),
            target_quiescence: StructuredProviderTargetQuiescenceV1::Unknown,
            detail: None,
        }
    }

    pub(crate) fn with_detail(mut self, detail: Option<String>) -> Self {
        self.detail = detail;
        self
    }

    pub(crate) fn without_target(mut self) -> Self {
        self.target_quiescence = StructuredProviderTargetQuiescenceV1::NoTarget;
        self
    }

    pub(crate) fn with_failed_binding(mut self, binding: AgentInteractionBindingV1) -> Self {
        self.target_quiescence =
            StructuredProviderTargetQuiescenceV1::ExactFailedBinding(Box::new(binding));
        self
    }

    pub(crate) fn with_target_quiescence(
        mut self,
        target_quiescence: StructuredProviderTargetQuiescenceV1,
    ) -> Self {
        self.target_quiescence = target_quiescence;
        self
    }

    pub(crate) fn retains_source(&self) -> bool {
        matches!(
            self.kind,
            StructuredProviderRuntimeErrorKindV1::RequestInvalid
                | StructuredProviderRuntimeErrorKindV1::CredentialStale
                | StructuredProviderRuntimeErrorKindV1::SourceBusy
                | StructuredProviderRuntimeErrorKindV1::RuntimeConflict
        )
    }
}

pub(crate) type StructuredProviderRuntimeFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, StructuredProviderRuntimeErrorV1>> + Send + 'a>>;

pub(crate) fn transition_owns_structured_source(
    transition: &AgentRuntimeTransitionRecordV1,
    binding: &AgentInteractionBindingV1,
) -> bool {
    matches!(
        &transition.intent.source_authority,
        AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding: source }
            if source == binding
    )
}

/// Resolves the provider conversation for one replacement effect. Fresh is
/// exact absence at admission, but a failed target may already have allocated
/// the identity that every later repair must resume.
pub(crate) fn replacement_provider_conversation_ref(
    planned: Option<&str>,
    failed_target: Option<&AgentInteractionBindingV1>,
) -> Option<String> {
    planned
        .map(str::to_owned)
        .or_else(|| failed_target.and_then(|binding| binding.provider_conversation_ref.clone()))
}

/// Validates the one post-launch binding change permitted by a Fresh target:
/// the provider may publish its newly allocated identity and advance the
/// binding revision exactly once. Resume targets remain exact.
pub(crate) fn replacement_target_conversation_matches(
    planned: Option<&str>,
    candidate: Option<&str>,
    published_binding_revision: i64,
    candidate_binding_revision: i64,
) -> bool {
    match (planned, candidate) {
        (Some(expected), Some(actual)) => {
            expected == actual && candidate_binding_revision == published_binding_revision
        }
        (Some(_), None) => false,
        (None, None) => candidate_binding_revision == published_binding_revision,
        (None, Some(_)) => published_binding_revision
            .checked_add(1)
            .is_some_and(|revision| candidate_binding_revision == revision),
    }
}

/// Provider-private process ownership behind the provider-neutral spawn,
/// inspect, and runtime-transition journals.
pub(crate) trait StructuredProviderRuntime: Send + Sync {
    /// Authoritative availability for new Chat sessions. Exact lifecycle
    /// operations remain available when this refuses a new session.
    fn new_session_availability(&self) -> Result<(), StructuredProviderRuntimeErrorV1> {
        Ok(())
    }

    fn open(
        &self,
        request: StructuredProviderOpenRequestV1,
    ) -> StructuredProviderRuntimeFuture<'_, AgentInteractionBindingV1>;

    /// Reconnects the detached control plane to an already selected logical
    /// conversation. An adapter may advance a provider runtime generation only
    /// after proving the selected generation is dead; pane state never enters
    /// this lifecycle path.
    fn attach_existing<'a>(
        &'a self,
        selection: &'a AgentRuntimeSelectionV1,
        binding: &'a AgentInteractionBindingV1,
    ) -> StructuredProviderRuntimeFuture<'a, AgentInteractionBindingV1>;

    fn open_replacement<'a>(
        &'a self,
        request: StructuredProviderOpenRequestV1,
        transition: &'a AgentRuntimeTransitionRecordV1,
        provider_state_environment: ProviderStateEnvironment,
    ) -> StructuredProviderRuntimeFuture<'a, AgentInteractionBindingV1>;

    fn stop_replacement_source<'a>(
        &'a self,
        transition: &'a AgentRuntimeTransitionRecordV1,
    ) -> StructuredProviderRuntimeFuture<'a, ()>;

    /// Retires the exact failed structured target moved into a corrected
    /// successor before that successor starts a non-structured target.
    fn retire_replacement_source<'a>(
        &'a self,
        transition: &'a AgentRuntimeTransitionRecordV1,
    ) -> StructuredProviderRuntimeFuture<'a, AgentRuntimeReplacementAuthorityV1>;

    fn stop_current<'a>(
        &'a self,
        binding: &'a AgentInteractionBindingV1,
    ) -> StructuredProviderRuntimeFuture<'a, ()>;
}

#[derive(Default)]
pub(crate) struct StructuredProviderRuntimeRegistry {
    runtimes: BTreeMap<ProviderIdV1, Arc<dyn StructuredProviderRuntime>>,
}

impl StructuredProviderRuntimeRegistry {
    pub(crate) fn register(
        &mut self,
        provider_id: ProviderIdV1,
        runtime: Arc<dyn StructuredProviderRuntime>,
    ) -> Result<(), &'static str> {
        if self.runtimes.contains_key(&provider_id) {
            return Err("structured provider runtime is already registered");
        }
        self.runtimes.insert(provider_id, runtime);
        Ok(())
    }

    pub(crate) fn resolve(
        &self,
        provider_id: &ProviderIdV1,
    ) -> Option<Arc<dyn StructuredProviderRuntime>> {
        self.runtimes.get(provider_id).map(Arc::clone)
    }

    pub(crate) fn supports_new_sessions(&self, provider_id: &ProviderIdV1) -> bool {
        self.new_session_availability(provider_id).is_ok()
    }

    pub(crate) fn new_session_availability(
        &self,
        provider_id: &ProviderIdV1,
    ) -> Result<(), StructuredProviderRuntimeErrorV1> {
        self.runtimes
            .get(provider_id)
            .ok_or_else(|| {
                StructuredProviderRuntimeErrorV1::new(
                    StructuredProviderRuntimeErrorKindV1::RuntimeUnavailable,
                    "agent_runtime_structured_profile_unavailable",
                )
            })?
            .new_session_availability()
    }

    pub(crate) fn providers(&self) -> BTreeSet<ProviderIdV1> {
        self.runtimes
            .keys()
            .filter(|provider_id| self.supports_new_sessions(provider_id))
            .cloned()
            .collect()
    }
}

/// Retire the one replacement fence carried by a failed transition before a
/// corrected non-structured successor takes authority. Native replacement
/// fences are returned unchanged because only their owning runtime adapter may
/// retire them.
pub(crate) async fn retire_transition_replacement_source(
    registry: &StructuredProviderRuntimeRegistry,
    transition: &AgentRuntimeTransitionRecordV1,
) -> Result<Option<AgentRuntimeReplacementAuthorityV1>, StructuredProviderRuntimeErrorV1> {
    let Some(authority) = transition.replacement_authority.as_ref() else {
        return Ok(None);
    };
    let AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding } = &authority.0 else {
        return Ok(Some(authority.clone()));
    };
    let runtime = registry.resolve(&binding.provider_id).ok_or_else(|| {
        StructuredProviderRuntimeErrorV1::new(
            StructuredProviderRuntimeErrorKindV1::RuntimeUnavailable,
            "agent_runtime_structured_profile_unavailable",
        )
    })?;
    runtime
        .retire_replacement_source(transition)
        .await
        .map(Some)
}

impl StructuredProviderRuntime for ClaudeStructuredRuntimeManager<SqliteDomainStore> {
    fn open(
        &self,
        request: StructuredProviderOpenRequestV1,
    ) -> StructuredProviderRuntimeFuture<'_, AgentInteractionBindingV1> {
        Box::pin(async move {
            ClaudeStructuredRuntimeManager::open(self, claude_request(request))
                .await
                .map(|receipt| receipt.binding)
                .map_err(claude_error)
        })
    }

    fn open_replacement<'a>(
        &'a self,
        request: StructuredProviderOpenRequestV1,
        transition: &'a AgentRuntimeTransitionRecordV1,
        provider_state_environment: ProviderStateEnvironment,
    ) -> StructuredProviderRuntimeFuture<'a, AgentInteractionBindingV1> {
        Box::pin(async move {
            ClaudeStructuredRuntimeManager::open_replacement(
                self,
                claude_request(request),
                transition,
                provider_state_environment,
            )
            .await
            .map(|receipt| receipt.binding)
            .map_err(|failure| {
                claude_error(failure.error)
                    .with_detail(failure.detail)
                    .with_target_quiescence(failure.target_quiescence)
            })
        })
    }

    fn attach_existing<'a>(
        &'a self,
        selection: &'a AgentRuntimeSelectionV1,
        binding: &'a AgentInteractionBindingV1,
    ) -> StructuredProviderRuntimeFuture<'a, AgentInteractionBindingV1> {
        Box::pin(async move {
            ClaudeStructuredRuntimeManager::attach_existing(self, selection, binding)
                .await
                .map_err(claude_error)
        })
    }

    fn stop_replacement_source<'a>(
        &'a self,
        transition: &'a AgentRuntimeTransitionRecordV1,
    ) -> StructuredProviderRuntimeFuture<'a, ()> {
        Box::pin(async move {
            ClaudeStructuredRuntimeManager::stop_replacement_source(self, transition)
                .await
                .map_err(claude_error)
        })
    }

    fn retire_replacement_source<'a>(
        &'a self,
        transition: &'a AgentRuntimeTransitionRecordV1,
    ) -> StructuredProviderRuntimeFuture<'a, AgentRuntimeReplacementAuthorityV1> {
        Box::pin(async move {
            ClaudeStructuredRuntimeManager::retire_replacement_source(self, transition)
                .await
                .map_err(claude_error)
        })
    }

    fn stop_current<'a>(
        &'a self,
        binding: &'a AgentInteractionBindingV1,
    ) -> StructuredProviderRuntimeFuture<'a, ()> {
        Box::pin(async move {
            ClaudeStructuredRuntimeManager::stop_terminal(self, binding)
                .await
                .map_err(claude_error)
        })
    }
}

fn claude_request(request: StructuredProviderOpenRequestV1) -> ClaudeStructuredOpenRequestV1 {
    ClaudeStructuredOpenRequestV1 {
        agent_id: request.agent_id,
        execution_profile: request.execution_profile,
        provider_conversation_ref: request.provider_conversation_ref,
        permission_mode: request.permission_mode,
        model: request.model,
        effort: request.effort,
    }
}

fn claude_error(error: ClaudeStructuredRuntimeErrorV1) -> StructuredProviderRuntimeErrorV1 {
    use ClaudeStructuredRuntimeErrorV1 as Claude;
    use StructuredProviderRuntimeErrorKindV1 as Kind;

    let kind = match &error {
        Claude::RequestInvalid => Kind::RequestInvalid,
        Claude::CredentialUnavailable => Kind::CredentialUnavailable,
        Claude::CredentialStale => Kind::CredentialStale,
        Claude::SourceBusy => Kind::SourceBusy,
        Claude::RuntimeConflict => Kind::RuntimeConflict,
        Claude::StopFailed => Kind::StopFailed,
        Claude::RuntimeLaunchRequired
        | Claude::HostAttachFailed
        | Claude::RelayReadinessFailed
        | Claude::HostAttachRecoveryRequired
        | Claude::RelayReadinessRecoveryRequired
        | Claude::ManagedCreateRecoveryRequired => Kind::ExplicitRecoveryRequired,
        Claude::RuntimeUnavailable
        | Claude::RelayLaunchFailed
        | Claude::ManagedCreateRecoveryPending
        | Claude::HostAttachUncertain
        | Claude::JournalFailed => Kind::LaunchFailed,
    };
    StructuredProviderRuntimeErrorV1::new(kind, error.code())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct LifecycleOnlyRuntime;

    impl StructuredProviderRuntime for LifecycleOnlyRuntime {
        fn new_session_availability(&self) -> Result<(), StructuredProviderRuntimeErrorV1> {
            Err(unavailable())
        }

        fn open(
            &self,
            _request: StructuredProviderOpenRequestV1,
        ) -> StructuredProviderRuntimeFuture<'_, AgentInteractionBindingV1> {
            Box::pin(async { Err(unavailable()) })
        }

        fn attach_existing<'a>(
            &'a self,
            _selection: &'a AgentRuntimeSelectionV1,
            _binding: &'a AgentInteractionBindingV1,
        ) -> StructuredProviderRuntimeFuture<'a, AgentInteractionBindingV1> {
            Box::pin(async { Err(unavailable()) })
        }

        fn open_replacement<'a>(
            &'a self,
            _request: StructuredProviderOpenRequestV1,
            _transition: &'a AgentRuntimeTransitionRecordV1,
            _provider_state_environment: ProviderStateEnvironment,
        ) -> StructuredProviderRuntimeFuture<'a, AgentInteractionBindingV1> {
            Box::pin(async { Err(unavailable()) })
        }

        fn stop_replacement_source<'a>(
            &'a self,
            _transition: &'a AgentRuntimeTransitionRecordV1,
        ) -> StructuredProviderRuntimeFuture<'a, ()> {
            Box::pin(async { Ok(()) })
        }

        fn retire_replacement_source<'a>(
            &'a self,
            _transition: &'a AgentRuntimeTransitionRecordV1,
        ) -> StructuredProviderRuntimeFuture<'a, AgentRuntimeReplacementAuthorityV1> {
            Box::pin(async { Err(unavailable()) })
        }

        fn stop_current<'a>(
            &'a self,
            _binding: &'a AgentInteractionBindingV1,
        ) -> StructuredProviderRuntimeFuture<'a, ()> {
            Box::pin(async { Ok(()) })
        }
    }

    fn unavailable() -> StructuredProviderRuntimeErrorV1 {
        StructuredProviderRuntimeErrorV1::new(
            StructuredProviderRuntimeErrorKindV1::RuntimeUnavailable,
            "structured_runtime_unavailable",
        )
    }

    #[test]
    fn a_failed_fresh_target_turns_its_allocated_identity_into_exact_resume() {
        let binding = AgentInteractionBindingV1 {
            schema_version: 1,
            interaction_session_id: dure_app::AgentInteractionSessionIdV1::new(
                "interaction-fresh-failed",
            )
            .unwrap(),
            agent_id: AgentIdV1::new("agent-fresh-failed").unwrap(),
            provider_id: ProviderIdV1::new("codex").unwrap(),
            execution_profile: AgentExecutionProfileV1::ProviderDefault,
            provider_conversation_ref: Some("allocated-conversation".into()),
            runtime: dure_app::AgentProviderRuntimeFenceV1 {
                runtime_generation: "runtime-fresh-failed".into(),
                provider_epoch: "provider-fresh-failed".into(),
            },
            timeline_epoch: dure_app::AgentTimelineEpochV1::new("timeline-fresh-failed").unwrap(),
            binding_revision: 1,
            history_complete: true,
            created_at_ms: 1,
            updated_at_ms: 1,
        };

        assert_eq!(
            replacement_provider_conversation_ref(None, Some(&binding)).as_deref(),
            Some("allocated-conversation")
        );
        assert_eq!(
            replacement_provider_conversation_ref(Some("planned-resume"), Some(&binding))
                .as_deref(),
            Some("planned-resume")
        );
        assert_eq!(replacement_provider_conversation_ref(None, None), None);
        assert!(replacement_target_conversation_matches(None, None, 2, 2));
        assert!(replacement_target_conversation_matches(
            None,
            Some("allocated-conversation"),
            2,
            3,
        ));
        assert!(!replacement_target_conversation_matches(
            None,
            Some("allocated-conversation"),
            2,
            4,
        ));
        assert!(replacement_target_conversation_matches(
            Some("planned-resume"),
            Some("planned-resume"),
            2,
            2,
        ));
    }

    #[test]
    fn lifecycle_only_runtime_remains_resolvable_without_advertising_chat() {
        let provider = ProviderIdV1::new("codex").unwrap();
        let mut registry = StructuredProviderRuntimeRegistry::default();
        registry
            .register(provider.clone(), Arc::new(LifecycleOnlyRuntime))
            .unwrap();

        assert!(registry.resolve(&provider).is_some());
        assert!(!registry.supports_new_sessions(&provider));
        assert!(!registry.providers().contains(&provider));
    }

    #[test]
    fn explicit_claude_launch_recovery_parks_provider_neutral_recovery() {
        for (source, code) in [
            (
                ClaudeStructuredRuntimeErrorV1::RuntimeLaunchRequired,
                "claude_conversation_runtime_unavailable",
            ),
            (
                ClaudeStructuredRuntimeErrorV1::HostAttachRecoveryRequired,
                "claude_conversation_host_attach_failed",
            ),
            (
                ClaudeStructuredRuntimeErrorV1::RelayReadinessRecoveryRequired,
                "claude_conversation_relay_readiness_failed",
            ),
            (
                ClaudeStructuredRuntimeErrorV1::ManagedCreateRecoveryRequired,
                "claude_conversation_managed_create_recovery_required",
            ),
        ] {
            let error = claude_error(source);
            assert_eq!(
                error.kind,
                StructuredProviderRuntimeErrorKindV1::ExplicitRecoveryRequired
            );
            assert_eq!(error.code, code);
        }

        let pending = claude_error(ClaudeStructuredRuntimeErrorV1::ManagedCreateRecoveryPending);
        assert_eq!(
            pending.kind,
            StructuredProviderRuntimeErrorKindV1::LaunchFailed
        );
        assert_eq!(
            pending.code,
            "claude_conversation_managed_create_recovery_pending"
        );
        assert_eq!(
            pending.target_quiescence,
            StructuredProviderTargetQuiescenceV1::Unknown
        );
    }

    #[test]
    fn stop_failures_retain_source_only_when_no_destructive_effect_occurred() {
        use StructuredProviderRuntimeErrorKindV1 as Kind;

        for kind in [
            Kind::RequestInvalid,
            Kind::CredentialStale,
            Kind::SourceBusy,
            Kind::RuntimeConflict,
        ] {
            assert!(StructuredProviderRuntimeErrorV1::new(kind, "refused").retains_source());
        }
        for kind in [
            Kind::RuntimeUnavailable,
            Kind::CredentialUnavailable,
            Kind::LaunchFailed,
            Kind::ExplicitRecoveryRequired,
            Kind::StopFailed,
        ] {
            assert!(!StructuredProviderRuntimeErrorV1::new(kind, "unknown").retains_source());
        }
    }
}
