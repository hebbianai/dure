mod interaction_progress;

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use agent_orchestration::domain::{DecisionState, InteractionRecord, InteractionTarget};
use dure_app::{
    AGENT_RUNTIME_CLOSE_SCHEMA_VERSION_V1, AgentCheckpointBindingAuthorityV1,
    AgentExecutionProfileV1, AgentIdV1, AgentInteractionBindingV1, AgentInteractionProfileV1,
    AgentInteractionSessionIdV1, AgentProviderRuntimeFenceV1, AgentRecordV1,
    AgentRuntimeBindingAuthorityV1, AgentRuntimeCloseAdvanceRequestV1, AgentRuntimeCloseAdvanceV1,
    AgentRuntimeCloseIntentV1, AgentRuntimeCloseStateV1, AgentRuntimeCloseStoppedTransitionV1,
    AgentRuntimeCloseStore, AgentRuntimeReplacementAuthorityUpdateV1,
    AgentRuntimeReplacementAuthorityV1, AgentRuntimeReplacementV1, AgentRuntimeSelectionV1,
    AgentRuntimeTargetFailureKindV1, AgentRuntimeTargetFailureV1,
    AgentRuntimeTransitionAdvanceRequestV1, AgentRuntimeTransitionAdvanceV1,
    AgentRuntimeTransitionIntentV1, AgentRuntimeTransitionRecordV1, AgentRuntimeTransitionStateV1,
    AgentRuntimeTransitionStore, AgentSpawnPermissionModeV1, AgentTimelineEpochV1,
    ContributionIdV2, DELEGATE_ONCE_SCHEMA_VERSION_V1, DelegateOnceReceiptV1,
    DelegateOnceRequestV1, DelegateOnceTaskSpecV1, DomainStore, OperationIdV1,
    PROVIDER_CREDENTIAL_PROFILE_SCHEMA_VERSION_V1, PROVIDER_LAUNCH_DEFAULTS_SCHEMA_VERSION_V1,
    ProjectIdV1, ProjectRecordV1, ProviderIdV1, ProviderLaunchDefaultV1,
    ProviderLaunchDefaultsPutRequestV1, ProviderLaunchPermissionModeV1, ProviderPermissionModeV1,
    RuntimeKindIdV1, SCHEDULE_SCHEMA_VERSION_V1, ScheduleIdV1, SchedulePutRequestV1,
    ScheduleRunTemplateV1, SessionBindingRecordV1, WorkflowCoordinatorBindingV1,
    WorkflowDispatchStateV1, WorkflowPromptActivityFailureV1, WorkflowPromptActivityFutureV1,
    WorkflowPromptActivityObservationRequestV1, WorkflowPromptActivityObserver,
    WorkflowPromptActivityReceiptV1, WorkflowPromptActivityStateV1, WorkflowPromptDeliverer,
    WorkflowPromptDeliveryEvidenceV1, WorkflowPromptDeliveryFailureV1,
    WorkflowPromptDeliveryFutureV1, WorkflowPromptDeliveryIntentV1,
    WorkflowPromptDeliveryRequestV1, WorkflowPromptDeliveryStateV1, WorkflowSessionGenerationV1,
    WorkflowSessionLaunchFailureV1, WorkflowSessionLaunchFutureV1, WorkflowSessionLaunchReceiptV1,
    WorkflowSessionLaunchRequestV1, WorkflowStore, WorkspaceIdV1, WorkspaceRecordV1,
};
use hmux_client::{
    MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER, MANAGED_STOP_BROKER_SUBCOMMAND,
    MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION, MANAGED_STOP_RECONCILE_BROKER_SUBCOMMAND,
    ManagedCreateGenerationFence, ManagedCreateOutcome, ManagedCreateReceipt, ManagedCreateRequest,
    ManagedRehostRecipe, ManagedRehostSourceRecipe, ManagedStopBrokerResponse,
    ManagedStopConversationFence, ManagedStopOutcome, ManagedStopQuiescenceFence,
    ManagedStopReceipt, ManagedStopRequest, PermissionMode as HmuxPermissionMode,
    ProcessDescriptor, ProviderStateEnvironment,
    recovery_journal::managed_create_ledger::{
        ManagedCreateLedgerState, managed_rehost_recipe, reserve, reserve_with_rehost_recipe,
    },
};
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use tokio::sync::{Mutex, Notify, Semaphore};

use super::*;

mod agent_conversation_recovery_tests;
mod agent_goal_tests;
mod agent_recovery_tests;
mod claude_goal_smoke;
pub(crate) mod goal_provider_smoke;
mod dispatch_stop_tests;
mod event_canary_tests;
mod graph_runtime_tests;
mod managed_create_reconcile_tests;
mod native_default_profile_tests;
mod orchestration_completion_tests;
mod orchestration_observation_tests;
mod prompt_recovery_tests;
mod real_hmux;
mod runtime_close_recovery_tests;
mod runtime_close_retirement_tests;
mod runtime_close_successor_tests;
mod runtime_idle_policy_tests;
mod runtime_native_rehost_tests;
mod runtime_preflight_tests;
mod runtime_recovery_tests;
mod runtime_stop_disposition_tests;
mod runtime_transition_deferred_tests;
mod runtime_transition_fresh_tests;
mod runtime_transition_hmux_tests;
mod runtime_transition_noop_tests;
mod runtime_transition_repair_tests;
mod runtime_transition_resume_tests;
mod schedule_runtime_tests;
mod slack_connector_tests;
mod slack_spawn_smoke;
mod spawn_destination_tests;

#[derive(Clone)]
enum LaunchOutcome {
    Succeed,
    AdvancedAfterProviderPathExists {
        session_id: &'static str,
        launch_idempotency_key: &'static str,
        relative_path: &'static str,
    },
    Advanced {
        session_id: &'static str,
        launch_idempotency_key: &'static str,
    },
    Fail(&'static str),
    Reject(&'static str),
}

#[derive(Clone)]
struct FakeLauncher {
    outcomes: Arc<StdMutex<VecDeque<LaunchOutcome>>>,
    requests: Arc<StdMutex<Vec<WorkflowSessionLaunchRequestV1>>>,
    provider_state_environments: Arc<StdMutex<Vec<hmux_client::ProviderStateEnvironment>>>,
    presentation_predecessors:
        Arc<StdMutex<Vec<Option<hmux_client::PresentationCheckpointPredecessor>>>>,
}

impl FakeLauncher {
    fn new(outcomes: impl IntoIterator<Item = LaunchOutcome>) -> Self {
        Self {
            outcomes: Arc::new(StdMutex::new(outcomes.into_iter().collect())),
            requests: Arc::new(StdMutex::new(Vec::new())),
            provider_state_environments: Arc::new(StdMutex::new(Vec::new())),
            presentation_predecessors: Arc::new(StdMutex::new(Vec::new())),
        }
    }

    fn requests(&self) -> Vec<WorkflowSessionLaunchRequestV1> {
        self.requests.lock().unwrap().clone()
    }

    fn provider_state_environments(&self) -> Vec<hmux_client::ProviderStateEnvironment> {
        self.provider_state_environments.lock().unwrap().clone()
    }

    fn presentation_predecessors(
        &self,
    ) -> Vec<Option<hmux_client::PresentationCheckpointPredecessor>> {
        self.presentation_predecessors.lock().unwrap().clone()
    }
}

impl workflow_launch::CredentialAwareWorkflowSessionLauncher for FakeLauncher {
    fn launch_with_provider_state(
        &self,
        request: WorkflowSessionLaunchRequestV1,
        provider_state_environment: hmux_client::ProviderStateEnvironment,
        presentation_predecessor: Option<hmux_client::PresentationCheckpointPredecessor>,
    ) -> WorkflowSessionLaunchFutureV1 {
        let outcome = self.outcomes.lock().unwrap().pop_front().unwrap();
        if let LaunchOutcome::AdvancedAfterProviderPathExists { relative_path, .. } = &outcome {
            let profile = provider_state_environment
                .values()
                .get("CODEX_HOME")
                .expect("credential launch must select CODEX_HOME");
            assert!(
                Path::new(profile).join(relative_path).exists(),
                "provider profile was not prepared before launch"
            );
        }
        self.provider_state_environments
            .lock()
            .unwrap()
            .push(provider_state_environment);
        self.presentation_predecessors
            .lock()
            .unwrap()
            .push(presentation_predecessor);
        self.requests.lock().unwrap().push(request.clone());
        Box::pin(async move {
            let (session_id, launch_idempotency_key) = match outcome {
                LaunchOutcome::Succeed => (request.session_id, request.launch_idempotency_key),
                LaunchOutcome::Advanced {
                    session_id,
                    launch_idempotency_key,
                }
                | LaunchOutcome::AdvancedAfterProviderPathExists {
                    session_id,
                    launch_idempotency_key,
                    ..
                } => (session_id.into(), launch_idempotency_key.into()),
                LaunchOutcome::Fail(code) => {
                    return Err(WorkflowSessionLaunchFailureV1::new(code).unwrap());
                }
                LaunchOutcome::Reject(code) => {
                    return Err(WorkflowSessionLaunchFailureV1::rejected(code).unwrap());
                }
            };
            Ok(WorkflowSessionLaunchReceiptV1 {
                launch_idempotency_key,
                session: WorkflowSessionGenerationV1 {
                    session_id,
                    workspace_id: request.workspace_id,
                    provider_id: request.provider_id,
                    runner_principal: "worker-runner".into(),
                    runner_instance: "worker-instance".into(),
                    channel_epoch: "2".into(),
                    host_instance_id: "worker-host".into(),
                    terminal_epoch: "worker-terminal".into(),
                },
            })
        })
    }
}

struct FailOnceProfilePreparer {
    attempts: Arc<AtomicUsize>,
    delegate: provider_credential_profile::NativeProviderCredentialProfileLaunchPreparer,
}

impl provider_credential_profile::ProviderCredentialProfileLaunchPreparer
    for FailOnceProfilePreparer
{
    fn prepare(
        &self,
        provider_id: &ProviderIdV1,
        directory: &Path,
    ) -> Result<
        dure_provider_profile::PreparedProviderProfileLaunch,
        provider_credential_profile::ProviderCredentialProfileErrorV1,
    > {
        if self.attempts.fetch_add(1, Ordering::SeqCst) == 0 {
            return Err(provider_credential_profile::ProviderCredentialProfileErrorV1::Unavailable);
        }
        self.delegate.prepare(provider_id, directory)
    }
}

#[derive(Clone)]
enum DeliveryOutcome {
    Succeed,
    Fail(&'static str, bool),
}

#[derive(Clone)]
struct FakePromptDeliverer {
    outcomes: Arc<StdMutex<VecDeque<DeliveryOutcome>>>,
    requests: Arc<StdMutex<Vec<WorkflowPromptDeliveryRequestV1>>>,
}

struct CountingStructuredRuntime {
    supports_new_sessions: bool,
    attach_count: Arc<AtomicUsize>,
    attach_error: Option<structured_provider_runtime::StructuredProviderRuntimeErrorKindV1>,
}

struct BusyStructuredRuntime {
    stop_count: Arc<AtomicUsize>,
    attach_count: Arc<AtomicUsize>,
    stop_error: Option<structured_provider_runtime::StructuredProviderRuntimeErrorKindV1>,
}

struct RepairableReplacementRuntime {
    store: Arc<dure_app_sqlite::SqliteDomainStore>,
    stop_count: Arc<AtomicUsize>,
    open_count: Arc<AtomicUsize>,
    first_failure_kind: structured_provider_runtime::StructuredProviderRuntimeErrorKindV1,
    second_failure_kind: Option<structured_provider_runtime::StructuredProviderRuntimeErrorKindV1>,
    succeed_on_retry: bool,
}

struct ReplacementLineageRuntime {
    store: Arc<dure_app_sqlite::SqliteDomainStore>,
    open_count: Arc<AtomicUsize>,
    retire_count: Arc<AtomicUsize>,
    observed_replacement_authorities:
        Arc<StdMutex<Vec<dure_app::AgentRuntimeReplacementAuthorityV1>>>,
}

impl CountingStructuredRuntime {
    fn unavailable() -> structured_provider_runtime::StructuredProviderRuntimeErrorV1 {
        structured_provider_runtime::StructuredProviderRuntimeErrorV1::new(
            structured_provider_runtime::StructuredProviderRuntimeErrorKindV1::RuntimeUnavailable,
            "counting_structured_runtime_unavailable",
        )
    }
}

impl structured_provider_runtime::StructuredProviderRuntime for CountingStructuredRuntime {
    fn new_session_availability(
        &self,
    ) -> Result<(), structured_provider_runtime::StructuredProviderRuntimeErrorV1> {
        self.supports_new_sessions
            .then_some(())
            .ok_or_else(Self::unavailable)
    }

    fn open(
        &self,
        _request: structured_provider_runtime::StructuredProviderOpenRequestV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'_, AgentInteractionBindingV1>
    {
        Box::pin(async { Err(Self::unavailable()) })
    }

    fn attach_existing<'a>(
        &'a self,
        _selection: &'a AgentRuntimeSelectionV1,
        binding: &'a AgentInteractionBindingV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, AgentInteractionBindingV1>
    {
        let attach_count = Arc::clone(&self.attach_count);
        let attach_error = self.attach_error;
        let binding = binding.clone();
        Box::pin(async move {
            attach_count.fetch_add(1, Ordering::SeqCst);
            match attach_error {
                Some(kind) => Err(
                    structured_provider_runtime::StructuredProviderRuntimeErrorV1::new(
                        kind,
                        "counting_structured_runtime_recovery_required",
                    ),
                ),
                None => Ok(binding),
            }
        })
    }

    fn open_replacement<'a>(
        &'a self,
        _request: structured_provider_runtime::StructuredProviderOpenRequestV1,
        _transition: &'a dure_app::AgentRuntimeTransitionRecordV1,
        _provider_state_environment: hmux_client::ProviderStateEnvironment,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, AgentInteractionBindingV1>
    {
        Box::pin(async { Err(Self::unavailable()) })
    }

    fn stop_replacement_source<'a>(
        &'a self,
        _transition: &'a dure_app::AgentRuntimeTransitionRecordV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }

    fn retire_replacement_source<'a>(
        &'a self,
        _transition: &'a dure_app::AgentRuntimeTransitionRecordV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<
        'a,
        dure_app::AgentRuntimeReplacementAuthorityV1,
    > {
        Box::pin(async { Err(CountingStructuredRuntime::unavailable()) })
    }

    fn stop_current<'a>(
        &'a self,
        _binding: &'a AgentInteractionBindingV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }
}

impl structured_provider_runtime::StructuredProviderRuntime for BusyStructuredRuntime {
    fn new_session_availability(
        &self,
    ) -> Result<(), structured_provider_runtime::StructuredProviderRuntimeErrorV1> {
        Err(CountingStructuredRuntime::unavailable())
    }

    fn open(
        &self,
        _request: structured_provider_runtime::StructuredProviderOpenRequestV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'_, AgentInteractionBindingV1>
    {
        Box::pin(async { Err(CountingStructuredRuntime::unavailable()) })
    }

    fn attach_existing<'a>(
        &'a self,
        _selection: &'a AgentRuntimeSelectionV1,
        binding: &'a AgentInteractionBindingV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, AgentInteractionBindingV1>
    {
        self.attach_count.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move { Ok(binding.clone()) })
    }

    fn open_replacement<'a>(
        &'a self,
        _request: structured_provider_runtime::StructuredProviderOpenRequestV1,
        _transition: &'a dure_app::AgentRuntimeTransitionRecordV1,
        _provider_state_environment: hmux_client::ProviderStateEnvironment,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, AgentInteractionBindingV1>
    {
        Box::pin(async { Err(CountingStructuredRuntime::unavailable()) })
    }

    fn stop_replacement_source<'a>(
        &'a self,
        _transition: &'a dure_app::AgentRuntimeTransitionRecordV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, ()> {
        self.stop_count.fetch_add(1, Ordering::SeqCst);
        let stop_error = self.stop_error;
        Box::pin(async move {
            match stop_error {
                Some(kind) => Err(
                    structured_provider_runtime::StructuredProviderRuntimeErrorV1::new(
                        kind,
                        "busy_structured_runtime_source_busy",
                    ),
                ),
                None => Ok(()),
            }
        })
    }

    fn stop_current<'a>(
        &'a self,
        _binding: &'a AgentInteractionBindingV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, ()> {
        self.stop_count.fetch_add(1, Ordering::SeqCst);
        let stop_error = self.stop_error;
        Box::pin(async move {
            match stop_error {
                Some(kind) => Err(
                    structured_provider_runtime::StructuredProviderRuntimeErrorV1::new(
                        kind,
                        "busy_structured_runtime_source_busy",
                    ),
                ),
                None => Ok(()),
            }
        })
    }

    fn retire_replacement_source<'a>(
        &'a self,
        _transition: &'a dure_app::AgentRuntimeTransitionRecordV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<
        'a,
        dure_app::AgentRuntimeReplacementAuthorityV1,
    > {
        Box::pin(async { Err(CountingStructuredRuntime::unavailable()) })
    }
}

impl structured_provider_runtime::StructuredProviderRuntime for RepairableReplacementRuntime {
    fn open(
        &self,
        _request: structured_provider_runtime::StructuredProviderOpenRequestV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'_, AgentInteractionBindingV1>
    {
        Box::pin(async { Err(CountingStructuredRuntime::unavailable()) })
    }

    fn attach_existing<'a>(
        &'a self,
        _selection: &'a AgentRuntimeSelectionV1,
        binding: &'a AgentInteractionBindingV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, AgentInteractionBindingV1>
    {
        Box::pin(async move { Ok(binding.clone()) })
    }

    fn open_replacement<'a>(
        &'a self,
        request: structured_provider_runtime::StructuredProviderOpenRequestV1,
        transition: &'a dure_app::AgentRuntimeTransitionRecordV1,
        _provider_state_environment: hmux_client::ProviderStateEnvironment,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, AgentInteractionBindingV1>
    {
        let attempt = self.open_count.fetch_add(1, Ordering::SeqCst);
        let failure_kind = match attempt {
            0 => Some(self.first_failure_kind),
            1 => self.second_failure_kind,
            _ => None,
        };
        if self.succeed_on_retry && failure_kind.is_none() {
            let AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding: source } =
                &transition.intent.source_authority
            else {
                unreachable!()
            };
            let store = Arc::clone(&self.store);
            let replacement = AgentRuntimeReplacementV1 {
                schema_version: 1,
                interaction_session_id: source.interaction_session_id.clone(),
                expected_binding_revision: source.binding_revision,
                source: source.runtime.clone(),
                source_execution_profile: source.execution_profile.clone(),
                target: AgentProviderRuntimeFenceV1 {
                    runtime_generation: "runtime-repaired".into(),
                    provider_epoch: "provider-repaired".into(),
                },
                target_execution_profile: request.execution_profile,
                provider_conversation_ref: request.provider_conversation_ref,
                replaced_at_ms: 30,
            };
            return Box::pin(async move {
                store
                    .replace_agent_interaction_runtime(&replacement)
                    .await
                    .map_err(|_| {
                        structured_provider_runtime::StructuredProviderRuntimeErrorV1::new(
                            structured_provider_runtime::StructuredProviderRuntimeErrorKindV1::LaunchFailed,
                            "fixture_binding_replace_failed",
                        )
                    })
            });
        }
        Box::pin(async move {
            Err(
                structured_provider_runtime::StructuredProviderRuntimeErrorV1::new(
                    failure_kind.unwrap_or(self.first_failure_kind),
                    "fixture_target_start_failed",
                )
                .without_target(),
            )
        })
    }

    fn stop_replacement_source<'a>(
        &'a self,
        _transition: &'a dure_app::AgentRuntimeTransitionRecordV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, ()> {
        self.stop_count.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(()) })
    }

    fn retire_replacement_source<'a>(
        &'a self,
        _transition: &'a dure_app::AgentRuntimeTransitionRecordV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<
        'a,
        dure_app::AgentRuntimeReplacementAuthorityV1,
    > {
        Box::pin(async { Err(CountingStructuredRuntime::unavailable()) })
    }

    fn stop_current<'a>(
        &'a self,
        _binding: &'a AgentInteractionBindingV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }
}

impl structured_provider_runtime::StructuredProviderRuntime for ReplacementLineageRuntime {
    fn open(
        &self,
        _request: structured_provider_runtime::StructuredProviderOpenRequestV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'_, AgentInteractionBindingV1>
    {
        Box::pin(async { Err(CountingStructuredRuntime::unavailable()) })
    }

    fn attach_existing<'a>(
        &'a self,
        _selection: &'a AgentRuntimeSelectionV1,
        binding: &'a AgentInteractionBindingV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, AgentInteractionBindingV1>
    {
        Box::pin(async move { Ok(binding.clone()) })
    }

    fn open_replacement<'a>(
        &'a self,
        request: structured_provider_runtime::StructuredProviderOpenRequestV1,
        transition: &'a dure_app::AgentRuntimeTransitionRecordV1,
        _provider_state_environment: hmux_client::ProviderStateEnvironment,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, AgentInteractionBindingV1>
    {
        let attempt = self.open_count.fetch_add(1, Ordering::SeqCst);
        let source = transition
            .replacement_authority
            .as_ref()
            .map(|authority| {
                self.observed_replacement_authorities
                    .lock()
                    .unwrap()
                    .push(authority.clone());
                let AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding } = &authority.0
                else {
                    panic!("structured target replacement requires a structured exact fence")
                };
                binding.clone()
            })
            .unwrap_or_else(|| {
                let AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding } =
                    &transition.intent.source_authority
                else {
                    panic!("fixture source must be structured")
                };
                binding.clone()
            });
        let store = Arc::clone(&self.store);
        let target_runtime = if attempt == 0 {
            AgentProviderRuntimeFenceV1 {
                runtime_generation: "runtime-failed-b".into(),
                provider_epoch: "provider-failed-b".into(),
            }
        } else {
            AgentProviderRuntimeFenceV1 {
                runtime_generation: "runtime-corrected-d".into(),
                provider_epoch: "provider-corrected-d".into(),
            }
        };
        Box::pin(async move {
            let replacement = AgentRuntimeReplacementV1 {
                schema_version: 1,
                interaction_session_id: source.interaction_session_id.clone(),
                expected_binding_revision: source.binding_revision,
                source: source.runtime.clone(),
                source_execution_profile: source.execution_profile.clone(),
                target: target_runtime,
                target_execution_profile: request.execution_profile,
                provider_conversation_ref: request.provider_conversation_ref,
                replaced_at_ms: 30 + attempt as i64,
            };
            let replaced = store
                .replace_agent_interaction_runtime(&replacement)
                .await
                .map_err(|_| {
                    structured_provider_runtime::StructuredProviderRuntimeErrorV1::new(
                        structured_provider_runtime::StructuredProviderRuntimeErrorKindV1::RuntimeConflict,
                        "fixture_lineage_binding_replace_failed",
                    )
                })?;
            if attempt == 0 {
                Err(
                    structured_provider_runtime::StructuredProviderRuntimeErrorV1::new(
                        structured_provider_runtime::StructuredProviderRuntimeErrorKindV1::ExplicitRecoveryRequired,
                        "fixture_lineage_target_failed",
                    )
                    .with_failed_binding(replaced),
                )
            } else {
                Ok(replaced)
            }
        })
    }

    fn stop_replacement_source<'a>(
        &'a self,
        _transition: &'a dure_app::AgentRuntimeTransitionRecordV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }

    fn retire_replacement_source<'a>(
        &'a self,
        transition: &'a dure_app::AgentRuntimeTransitionRecordV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<
        'a,
        dure_app::AgentRuntimeReplacementAuthorityV1,
    > {
        self.retire_count.fetch_add(1, Ordering::SeqCst);
        let authority = transition
            .replacement_authority
            .as_ref()
            .expect("native successor must own the failed structured fence")
            .clone();
        self.observed_replacement_authorities
            .lock()
            .unwrap()
            .push(authority.clone());
        let AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding: source } = authority.0
        else {
            panic!("fixture retirement source must be structured")
        };
        let store = Arc::clone(&self.store);
        let target_execution_profile = transition.intent.target_execution_profile.clone();
        Box::pin(async move {
            let target_runtime = AgentProviderRuntimeFenceV1 {
                runtime_generation: "runtime-tombstone-c".into(),
                provider_epoch: "provider-tombstone-c".into(),
            };
            let current = store
                .agent_interaction_for_agent(&source.agent_id)
                .await
                .map_err(|_| {
                    structured_provider_runtime::StructuredProviderRuntimeErrorV1::new(
                        structured_provider_runtime::StructuredProviderRuntimeErrorKindV1::RuntimeUnavailable,
                        "fixture_lineage_retirement_unavailable",
                    )
                })?;
            if let Some(current) = current {
                if current.interaction_session_id == source.interaction_session_id
                    && current.agent_id == source.agent_id
                    && current.provider_id == source.provider_id
                    && current.binding_revision == source.binding_revision + 1
                    && current.runtime == target_runtime
                    && current.execution_profile == target_execution_profile
                    && current.provider_conversation_ref == source.provider_conversation_ref
                {
                    return Ok(dure_app::AgentRuntimeReplacementAuthorityV1(
                        AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding: current },
                    ));
                }
            }
            let replacement = AgentRuntimeReplacementV1 {
                schema_version: 1,
                interaction_session_id: source.interaction_session_id.clone(),
                expected_binding_revision: source.binding_revision,
                source: source.runtime.clone(),
                source_execution_profile: source.execution_profile.clone(),
                target: target_runtime,
                target_execution_profile,
                provider_conversation_ref: source.provider_conversation_ref.clone(),
                replaced_at_ms: source.updated_at_ms.saturating_add(1),
            };
            let retired = store
                .replace_agent_interaction_runtime(&replacement)
                .await
                .map_err(|_| {
                    structured_provider_runtime::StructuredProviderRuntimeErrorV1::new(
                        structured_provider_runtime::StructuredProviderRuntimeErrorKindV1::RuntimeConflict,
                        "fixture_lineage_retirement_failed",
                    )
                })?;
            Ok(dure_app::AgentRuntimeReplacementAuthorityV1(
                AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding: retired },
            ))
        })
    }

    fn stop_current<'a>(
        &'a self,
        _binding: &'a AgentInteractionBindingV1,
    ) -> structured_provider_runtime::StructuredProviderRuntimeFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }
}

impl FakePromptDeliverer {
    fn new(outcomes: impl IntoIterator<Item = DeliveryOutcome>) -> Self {
        Self {
            outcomes: Arc::new(StdMutex::new(outcomes.into_iter().collect())),
            requests: Arc::new(StdMutex::new(Vec::new())),
        }
    }

    fn requests(&self) -> Vec<WorkflowPromptDeliveryRequestV1> {
        self.requests.lock().unwrap().clone()
    }
}

impl WorkflowPromptDeliverer for FakePromptDeliverer {
    fn deliver(&self, request: WorkflowPromptDeliveryRequestV1) -> WorkflowPromptDeliveryFutureV1 {
        let terminal_epoch = request.session.terminal_epoch.clone();
        self.requests.lock().unwrap().push(request);
        let outcome = self.outcomes.lock().unwrap().pop_front().unwrap();
        Box::pin(async move {
            match outcome {
                DeliveryOutcome::Succeed => Ok(WorkflowPromptDeliveryEvidenceV1::agent_prompt(
                    terminal_epoch,
                    "4",
                    "8",
                    Some("3".into()),
                )),
                DeliveryOutcome::Fail(code, may_have_written) => {
                    Err(WorkflowPromptDeliveryFailureV1::new(code, may_have_written).unwrap())
                }
            }
        })
    }
}

#[derive(Clone)]
enum ActivityOutcome {
    Observed(&'static str),
    Stalled(&'static str),
    Fail(&'static str, &'static str),
}

#[derive(Clone)]
struct FakePromptActivityObserver {
    outcomes: Arc<StdMutex<VecDeque<ActivityOutcome>>>,
    requests: Arc<StdMutex<Vec<WorkflowPromptActivityObservationRequestV1>>>,
}

impl FakePromptActivityObserver {
    fn new(outcomes: impl IntoIterator<Item = ActivityOutcome>) -> Self {
        Self {
            outcomes: Arc::new(StdMutex::new(outcomes.into_iter().collect())),
            requests: Arc::new(StdMutex::new(Vec::new())),
        }
    }

    fn requests(&self) -> Vec<WorkflowPromptActivityObservationRequestV1> {
        self.requests.lock().unwrap().clone()
    }
}

impl WorkflowPromptActivityObserver for FakePromptActivityObserver {
    fn observe(
        &self,
        request: WorkflowPromptActivityObservationRequestV1,
    ) -> WorkflowPromptActivityFutureV1 {
        self.requests.lock().unwrap().push(request);
        let outcome = self.outcomes.lock().unwrap().pop_front().unwrap();
        Box::pin(async move {
            match outcome {
                ActivityOutcome::Observed(output_seq) => Ok(WorkflowPromptActivityReceiptV1 {
                    state: WorkflowPromptActivityStateV1::Observed,
                    observed_output_seq: output_seq.into(),
                    error_code: None,
                }),
                ActivityOutcome::Stalled(output_seq) => Ok(WorkflowPromptActivityReceiptV1 {
                    state: WorkflowPromptActivityStateV1::Stalled,
                    observed_output_seq: output_seq.into(),
                    error_code: Some("workflow_prompt_stalled".into()),
                }),
                ActivityOutcome::Fail(code, output_seq) => {
                    Err(WorkflowPromptActivityFailureV1::new(code, output_seq).unwrap())
                }
            }
        })
    }
}

fn request() -> DelegateOnceRequestV1 {
    DelegateOnceRequestV1 {
        schema_version: DELEGATE_ONCE_SCHEMA_VERSION_V1,
        contribution_id: ContributionIdV2::new("dure.core.delegate-once").unwrap(),
        coordinator: WorkflowCoordinatorBindingV1 {
            agent_id: AgentIdV1::new("coordinator-1").unwrap(),
            session_id: "coordinator-session".into(),
            binding_generation: 1,
        },
        task: DelegateOnceTaskSpecV1 {
            summary: "Review the bounded change".into(),
            instructions: "Inspect the requested change and return findings.".into(),
        },
        provider_id: ProviderIdV1::new("codex").unwrap(),
        runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
        target_reference: "backend-profile:local".into(),
        idempotency_key: "workflow-control-plane-1".into(),
        created_at_ms: 1_000,
    }
}

async fn fixture(
    outcomes: Vec<LaunchOutcome>,
) -> (TempDir, ServiceState, FakeLauncher, FakePromptDeliverer) {
    fixture_with_delivery(outcomes, vec![DeliveryOutcome::Succeed]).await
}

// Real-provider goal QA reuses the same canonical backend fixture and replaces
// its conversation service with the managed provider runtime.
pub(crate) async fn goal_runtime_fixture() -> (TempDir, ServiceState) {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    make_fixture_mutation_authority(&mut state);
    (root, state)
}

pub(crate) async fn reopen_goal_runtime_fixture(
    state: &ServiceState,
    database: &std::path::Path,
) -> ServiceState {
    let (mut reopened, _) = reopen_fixture_service_state(state, database).await;
    reopened.descriptor.generation = "local-v1-11111111111111111111111111111111".into();
    make_fixture_mutation_authority(&mut reopened);
    reopened
}

async fn fixture_with_delivery(
    outcomes: Vec<LaunchOutcome>,
    delivery_outcomes: Vec<DeliveryOutcome>,
) -> (TempDir, ServiceState, FakeLauncher, FakePromptDeliverer) {
    let (root, state, launcher, deliverer, _) = fixture_with_observation(
        outcomes,
        delivery_outcomes,
        vec![ActivityOutcome::Observed("9")],
    )
    .await;
    (root, state, launcher, deliverer)
}

async fn fixture_with_observation(
    outcomes: Vec<LaunchOutcome>,
    delivery_outcomes: Vec<DeliveryOutcome>,
    activity_outcomes: Vec<ActivityOutcome>,
) -> (
    TempDir,
    ServiceState,
    FakeLauncher,
    FakePromptDeliverer,
    FakePromptActivityObserver,
) {
    fixture_with_source_authority(
        outcomes,
        delivery_outcomes,
        activity_outcomes,
        HmuxPermissionMode::Default,
        "coordinator-terminal",
    )
    .await
}

async fn fixture_with_source_authority(
    outcomes: Vec<LaunchOutcome>,
    delivery_outcomes: Vec<DeliveryOutcome>,
    activity_outcomes: Vec<ActivityOutcome>,
    permission_mode: HmuxPermissionMode,
    terminal_epoch: &str,
) -> (
    TempDir,
    ServiceState,
    FakeLauncher,
    FakePromptDeliverer,
    FakePromptActivityObserver,
) {
    fixture_with_source_launch_authority(
        outcomes,
        delivery_outcomes,
        activity_outcomes,
        permission_mode,
        terminal_epoch,
        SourceLaunchAuthorityFixture::default(),
    )
    .await
}

struct SourceLaunchAuthorityFixture {
    include_rehost_recipe: bool,
    source_provider_id: &'static str,
    agent_id: AgentIdV1,
    launch_reference: Option<String>,
    launch_profile_directory_name: Option<String>,
    conversation_id: Option<String>,
    credential_reference_id: Option<String>,
    provider_state_environment: ProviderStateEnvironment,
    agent_provider_id: ProviderIdV1,
}

impl Default for SourceLaunchAuthorityFixture {
    fn default() -> Self {
        Self {
            include_rehost_recipe: false,
            source_provider_id: "codex",
            agent_id: AgentIdV1::new("coordinator-1").unwrap(),
            launch_reference: None,
            launch_profile_directory_name: None,
            conversation_id: None,
            credential_reference_id: None,
            provider_state_environment: ProviderStateEnvironment::default(),
            agent_provider_id: ProviderIdV1::new("provider.codex").unwrap(),
        }
    }
}

async fn fixture_with_source_launch_authority(
    outcomes: Vec<LaunchOutcome>,
    delivery_outcomes: Vec<DeliveryOutcome>,
    activity_outcomes: Vec<ActivityOutcome>,
    permission_mode: HmuxPermissionMode,
    terminal_epoch: &str,
    source_authority: SourceLaunchAuthorityFixture,
) -> (
    TempDir,
    ServiceState,
    FakeLauncher,
    FakePromptDeliverer,
    FakePromptActivityObserver,
) {
    let root = tempfile::tempdir().unwrap();
    fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let discovery_root = root.path().join("discovery");
    fs::create_dir(&discovery_root).unwrap();
    fs::set_permissions(&discovery_root, fs::Permissions::from_mode(0o700)).unwrap();
    // The launch broker and control plane may reach the same ledger through
    // different absolute path aliases (for example /var and /private/var on
    // macOS). Ledger location, rather than receipt spelling, is authoritative.
    let launch_discovery_root = discovery_root.join("..").join("discovery");
    let provider_state_environment = match &source_authority.launch_profile_directory_name {
        Some(profile_directory_name) => {
            let accounts = root.path().join("accounts");
            fs::create_dir(&accounts).unwrap();
            fs::set_permissions(&accounts, fs::Permissions::from_mode(0o700)).unwrap();
            let profile_directory = accounts.join(profile_directory_name);
            fs::create_dir(&profile_directory).unwrap();
            fs::set_permissions(&profile_directory, fs::Permissions::from_mode(0o700)).unwrap();
            provider_credential_profile::native_provider_state_environment(
                &ProviderIdV1::new("codex").unwrap(),
                Some(
                    &provider_credential_profile::ResolvedProviderCredentialProfileV1::for_test(
                        "codex",
                        "fixture-account",
                        "fixture-generation",
                        fs::canonicalize(profile_directory).unwrap(),
                    ),
                ),
            )
            .unwrap()
        }
        None => source_authority.provider_state_environment.clone(),
    };
    let source_create = if source_authority.include_rehost_recipe {
        let mut source_request = ManagedCreateRequest::new(
            "coordinator-create",
            "coordinator-session",
            "coordinator-workspace",
            source_authority.source_provider_id,
            permission_mode,
            root.path(),
            vec![source_authority.source_provider_id.into()],
            24,
            80,
        )
        .unwrap()
        .with_required_managed_stop_request_version(MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION)
        .unwrap()
        .with_managed_rehost_recipe(
            ManagedRehostRecipe::new(
                vec![
                    source_authority.source_provider_id.into(),
                    "resume".into(),
                    MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER.into(),
                ],
                source_authority.launch_reference.clone(),
            )
            .unwrap(),
        )
        .unwrap();
        if !provider_state_environment.is_empty() {
            source_request = source_request
                .with_provider_state_environment(provider_state_environment)
                .unwrap();
        }
        let source_recipe = ManagedRehostSourceRecipe::from_create_request(&source_request)
            .unwrap()
            .unwrap();
        let serialized_source_recipe = serde_json::to_string(&source_recipe).unwrap();
        reserve_with_rehost_recipe(
            &launch_discovery_root,
            "coordinator-workspace",
            "coordinator-session",
            "coordinator-create",
            &"ab".repeat(32),
            Some(&serialized_source_recipe),
        )
        .unwrap()
    } else {
        reserve(
            &launch_discovery_root,
            "coordinator-workspace",
            "coordinator-session",
            "coordinator-create",
            &"ab".repeat(32),
        )
        .unwrap()
    };
    let ManagedCreateLedgerState::Prepared(mut source_create) = source_create else {
        panic!("source create authority must start prepared")
    };
    source_create.checkpoint_pre_spawn_absence().unwrap();
    source_create
        .mark_spawn_reserved(ProcessDescriptor {
            process_id: 101,
            start_marker: "coordinator-host-process".into(),
        })
        .unwrap();
    source_create.release_with_barrier_proof().unwrap();
    let source_receipt = ManagedCreateReceipt::new(
        "coordinator-create",
        "coordinator-session",
        "coordinator-workspace",
        source_authority.source_provider_id,
        permission_mode,
        &launch_discovery_root,
        ManagedCreateOutcome::Created,
    )
    .unwrap()
    .with_generation_fence(
        ManagedCreateGenerationFence::new(
            "coordinator-runner",
            "coordinator-instance",
            1,
            "coordinator-host",
            terminal_epoch,
        )
        .unwrap(),
    )
    .unwrap();
    source_create
        .complete(serde_json::to_string(&source_receipt).unwrap())
        .unwrap();
    let hmux = root.path().join("hmux-fixture");
    let coordinator = json!({
        "schema_version": 1,
        "session_id": "coordinator-session",
        "workspace_id": "coordinator-workspace",
        "session_class": "managed",
        "lifecycle": "ready",
        "provider_id": source_authority.source_provider_id,
        "runner_principal": "coordinator-runner",
        "runner_instance": "coordinator-instance",
        "channel_epoch": "1",
        "host_instance_id": "coordinator-host",
        "terminal_epoch": "coordinator-terminal",
        "health": "healthy",
        "providerConversationIdentity": source_authority.conversation_id.as_ref().map(|conversation_id| json!({
            "session_id": "coordinator-session",
            "workspace_id": "coordinator-workspace",
            "runner_principal": "coordinator-runner",
            "runner_instance": "coordinator-instance",
            "channel_epoch": "1",
            "host_instance_id": "coordinator-host",
            "terminal_epoch": "coordinator-terminal",
            "provider_id": source_authority.source_provider_id,
            "conversation_id": conversation_id,
        }))
    });
    fs::write(
        &hmux,
        format!(
            "#!/bin/sh\nif [ \"${{4:-}}\" = managed-rehost-resolve ] && [ -f '{}' ]; then cat '{}'; exit 0; fi\nif [ \"${{4:-}}\" = session ] && [ -f '{}' ]; then cat '{}'; exit 0; fi\nprintf '%s' '{}'\n",
            discovery_root.join("rehost-resolution.json").display(),
            discovery_root.join("rehost-resolution.json").display(),
            discovery_root.join("current-session.json").display(),
            discovery_root.join("current-session.json").display(),
            coordinator,
        ),
    )
    .unwrap();
    fs::set_permissions(&hmux, fs::Permissions::from_mode(0o700)).unwrap();
    let hmux_runtime = root.path().join("hmux-runtime-fixture");
    fs::write(&hmux_runtime, "#!/bin/sh\nexit 0\n").unwrap();
    fs::set_permissions(&hmux_runtime, fs::Permissions::from_mode(0o700)).unwrap();
    let provider = root.path().join("codex-fixture");
    fs::write(&provider, "#!/bin/sh\nexit 0\n").unwrap();
    fs::set_permissions(&provider, fs::Permissions::from_mode(0o700)).unwrap();

    let hmux_identity =
        resolve_hmux_toolchain_identity(&hmux, &hmux_runtime, &discovery_root).unwrap();
    let store = Arc::new(
        SqliteDomainStore::open(root.path().join("domain.sqlite"))
            .await
            .unwrap(),
    );
    let project_id = ProjectIdV1::new("project-1").unwrap();
    let workspace_id = WorkspaceIdV1::new("workspace-1").unwrap();
    let agent_id = source_authority.agent_id.clone();
    store
        .upsert_project(&ProjectRecordV1 {
            project_id: project_id.clone(),
            root_path: root.path().to_string_lossy().into_owned(),
            display_name: "Fixture project".into(),
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .await
        .unwrap();
    store
        .upsert_workspace(&WorkspaceRecordV1 {
            workspace_id: workspace_id.clone(),
            project_id,
            root_path: root.path().to_string_lossy().into_owned(),
            base_commit_sha: None,
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .await
        .unwrap();
    store
        .upsert_agent(&AgentRecordV1 {
            agent_id: agent_id.clone(),
            workspace_id,
            provider_id: source_authority.agent_provider_id,
            display_name: "Coordinator".into(),
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .await
        .unwrap();
    store
        .upsert_agent_checkpoint_binding_authority(&AgentCheckpointBindingAuthorityV1 {
            schema_version: AGENT_CHECKPOINT_SCHEMA_VERSION_V1,
            binding: SessionBindingRecordV1 {
                agent_id,
                runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
                session_id: "coordinator-session".into(),
                provider_conversation_id: source_authority.conversation_id.clone(),
                credential_reference_id: source_authority.credential_reference_id.clone(),
                binding_generation: 1,
                bound_at_ms: 1,
            },
            runtime_workspace_id: "coordinator-workspace".into(),
            runner_principal: "coordinator-runner".into(),
            runner_instance: "coordinator-instance".into(),
            channel_epoch: "1".into(),
            host_instance_id: "coordinator-host".into(),
            terminal_epoch: "coordinator-terminal".into(),
            updated_at_ms: 1,
        })
        .await
        .unwrap();

    let launcher = FakeLauncher::new(outcomes);
    let prompt_deliverer = FakePromptDeliverer::new(delivery_outcomes);
    let prompt_activity_observer = FakePromptActivityObserver::new(activity_outcomes);
    let canonical_descriptor_path = root.path().join("control-plane.json");
    let descriptor = ServiceDescriptor {
        schema_version: 1,
        backend_id: BACKEND_ID.into(),
        build_id: Some(control_plane_build_id().into()),
        generation: "local-v1-00000000000000000000000000000000".into(),
        activation_source_generation: None,
        socket_path: root.path().join("control-plane.sock"),
        database_path: root.path().join("domain.sqlite"),
        control_plane_identity: None,
        hmux_executable_path: Some(hmux_identity.executable_path.clone()),
        hmux_executable_device: None,
        hmux_executable_inode: None,
        hmux_executable_size: None,
        hmux_executable_modified: None,
        hmux_executable_sha256: None,
        hmux_runtime_executable_path: Some(hmux_identity.runtime_executable_path.clone()),
        hmux_runtime_executable_device: None,
        hmux_runtime_executable_inode: None,
        hmux_runtime_executable_size: None,
        hmux_runtime_executable_modified: None,
        hmux_runtime_executable_sha256: None,
        hmux_discovery_root: Some(hmux_identity.discovery_root.clone()),
        hmux_discovery_device: None,
        hmux_discovery_inode: None,
        process_id: std::process::id(),
        observed_at_ms: 1,
    };
    write_descriptor(&canonical_descriptor_path, &descriptor).unwrap();
    let agent_conversation_service = Arc::new(agent_conversation::AgentConversationService::new(
        Arc::clone(&store),
    ));
    let agent_conversation_runtimes =
        Arc::new(agent_conversation_api::AgentConversationRuntimeRegistry::default());
    let agent_conversations = Arc::new(agent_conversation_api::AgentConversationApi::new(
        agent_conversation_service,
        Arc::clone(&agent_conversation_runtimes),
    ));
    let credential_profiles = Arc::new(
        provider_credential_profile::ProviderCredentialProfileRegistry::new(
            root.path().to_path_buf(),
            Arc::clone(&store),
        ),
    );
    let state = ServiceState {
        scope_id: crate::backend_scope::load_or_create(
            ensure_backend_root(root.path()).unwrap().durable(),
        )
        .unwrap(),
        slack: crate::slack_connector::SlackConnectorService::new(
            ensure_backend_root(root.path()).unwrap().durable(),
            root.path(),
            root.path().join("dure.mjs"),
            hmux_identity.clone(),
        ),
        browser: crate::browser_service::BrowserService::new(
            ensure_backend_root(root.path()).unwrap(),
            &descriptor.generation,
            root.path(),
        ),
        descriptor,
        canonical_descriptor_path,
        projects_catalog_path: root.path().join("backend-projects.json"),
        agent_providers: Arc::new(provider_extension::test_agent_provider_registry(
            provider.to_str().unwrap(),
        )),
        runtime_adapters: Arc::new(runtime_extension::local_hmux_runtime_registry(
            hmux_identity.clone(),
        )),
        credential_aware_workflow_launcher: Arc::new(launcher.clone()),
        workflow_prompt_deliverer: Arc::new(prompt_deliverer.clone()),
        workflow_prompt_activity_observer: Arc::new(prompt_activity_observer.clone()),
        workspace_acquirer: Arc::new(workspace_git::GitWorkspaceAcquirer::default()),
        hmux_identity,
        store,
        credential_profiles,
        claude_runtime: None,
        structured_runtimes: Arc::new(
            crate::structured_provider_runtime::StructuredProviderRuntimeRegistry::default(),
        ),
        agent_conversation_runtimes,
        agent_conversations,
        agent_operations: crate::agent_operation_lock::AgentOperationLocks::default(),
        agent_runtime_recovery_wake: Notify::new(),
        goal_wakeup: Notify::new(),
        runtime_idle: Default::default(),
        project_catalog_lock: Mutex::new(()),
        workflow_lock: Mutex::new(()),
        request_slots: Arc::new(Semaphore::new(1)),
        subscription_slots: Arc::new(Semaphore::new(1)),
        connection_slots: Arc::new(Semaphore::new(1)),
        shutdown: Notify::new(),
    };
    (
        root,
        state,
        launcher,
        prompt_deliverer,
        prompt_activity_observer,
    )
}

fn complete_fixture_managed_create(
    state: &ServiceState,
    session: &WorkflowSessionGenerationV1,
    launch_idempotency_key: &str,
) {
    let ledger = reserve(
        &state.hmux_identity.discovery_root,
        &session.workspace_id,
        &session.session_id,
        launch_idempotency_key,
        &"cd".repeat(32),
    )
    .unwrap();
    let ManagedCreateLedgerState::Prepared(mut prepared) = ledger else {
        panic!("fixture managed create must start prepared")
    };
    prepared.checkpoint_pre_spawn_absence().unwrap();
    prepared
        .mark_spawn_reserved(ProcessDescriptor {
            process_id: 202,
            start_marker: format!("{}-process", session.host_instance_id),
        })
        .unwrap();
    prepared.release_with_barrier_proof().unwrap();
    let receipt = ManagedCreateReceipt::new(
        launch_idempotency_key,
        &session.session_id,
        &session.workspace_id,
        session.provider_id.as_str(),
        HmuxPermissionMode::Default,
        &state.hmux_identity.discovery_root,
        ManagedCreateOutcome::Created,
    )
    .unwrap()
    .with_generation_fence(
        ManagedCreateGenerationFence::new(
            &session.runner_principal,
            &session.runner_instance,
            session.channel_epoch.parse().unwrap(),
            &session.host_instance_id,
            &session.terminal_epoch,
        )
        .unwrap(),
    )
    .unwrap();
    prepared
        .complete(serde_json::to_string(&receipt).unwrap())
        .unwrap();
}

fn complete_fixture_managed_rehost_create(
    state: &ServiceState,
    source: &WorkflowSessionGenerationV1,
    target: &WorkflowSessionGenerationV1,
    launch_idempotency_key: &str,
    permission_mode: HmuxPermissionMode,
) {
    let source_recipe = managed_rehost_recipe(
        &state.hmux_identity.discovery_root,
        &source.workspace_id,
        &source.session_id,
    )
    .unwrap()
    .expect("the source fixture must carry an exact rehost recipe");
    let target_request = ManagedCreateRequest::new(
        launch_idempotency_key,
        &target.session_id,
        &target.workspace_id,
        source_recipe.provider_id(),
        source_recipe.permission_mode(),
        source_recipe.provider_cwd(),
        vec!["fixture-provider".into()],
        source_recipe.initial_rows(),
        source_recipe.initial_columns(),
    )
    .unwrap()
    .with_required_managed_stop_request_version(
        source_recipe.required_managed_stop_request_version(),
    )
    .unwrap()
    .with_terminal_environment(source_recipe.terminal_environment().clone())
    .unwrap()
    .with_provider_state_environment(source_recipe.provider_state_environment().clone())
    .unwrap()
    .with_managed_rehost_recipe(source_recipe.rehost().clone())
    .unwrap()
    .with_terminal_default_colors_option(source_recipe.terminal_default_colors())
    .unwrap();
    let target_recipe = ManagedRehostSourceRecipe::from_create_request(&target_request)
        .unwrap()
        .expect("the target fixture must carry its retargeted rehost recipe");
    let target_recipe = serde_json::to_string(&target_recipe).unwrap();
    let ledger = reserve_with_rehost_recipe(
        &state.hmux_identity.discovery_root,
        &target.workspace_id,
        &target.session_id,
        launch_idempotency_key,
        &"ef".repeat(32),
        Some(&target_recipe),
    )
    .unwrap();
    let ManagedCreateLedgerState::Prepared(mut prepared) = ledger else {
        panic!("fixture managed rehost create must start prepared")
    };
    prepared.checkpoint_pre_spawn_absence().unwrap();
    prepared
        .mark_spawn_reserved(ProcessDescriptor {
            process_id: 303,
            start_marker: format!("{}-process", target.host_instance_id),
        })
        .unwrap();
    prepared.release_with_barrier_proof().unwrap();
    let receipt = ManagedCreateReceipt::new(
        launch_idempotency_key,
        &target.session_id,
        &target.workspace_id,
        target.provider_id.as_str(),
        permission_mode,
        &state.hmux_identity.discovery_root,
        ManagedCreateOutcome::Created,
    )
    .unwrap()
    .with_generation_fence(
        ManagedCreateGenerationFence::new(
            &target.runner_principal,
            &target.runner_instance,
            target.channel_epoch.parse().unwrap(),
            &target.host_instance_id,
            &target.terminal_epoch,
        )
        .unwrap(),
    )
    .unwrap();
    prepared
        .complete(serde_json::to_string(&receipt).unwrap())
        .unwrap();
}

async fn set_fixture_effective_launch(
    state: &ServiceState,
    dispatch_id: &DispatchIdV1,
    effective_launch_idempotency_key: Option<&str>,
) {
    let pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(&state.descriptor.database_path),
    )
    .await
    .unwrap();
    let updated = sqlx::query(
        "UPDATE workflow_dispatch_launches SET effective_launch_idempotency_key = ?1 WHERE dispatch_id = ?2",
    )
    .bind(effective_launch_idempotency_key)
    .bind(dispatch_id.as_str())
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(updated.rows_affected(), 1);
    pool.close().await;
}

async fn fixture_effective_launch(state: &ServiceState, dispatch_id: &str) -> Option<String> {
    let pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(&state.descriptor.database_path),
    )
    .await
    .unwrap();
    let value = sqlx::query_scalar(
        "SELECT effective_launch_idempotency_key FROM workflow_dispatch_launches WHERE dispatch_id = ?1",
    )
    .bind(dispatch_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    pool.close().await;
    value
}

async fn reopen_fixture_service_state(
    state: &ServiceState,
    database_path: &std::path::Path,
) -> (ServiceState, FakeLauncher) {
    let (reopened, launcher, _, _) =
        reopen_fixture_service_state_with_prompt_observation(state, database_path).await;
    (reopened, launcher)
}

async fn reopen_fixture_service_state_with_prompt_observation(
    state: &ServiceState,
    database_path: &std::path::Path,
) -> (
    ServiceState,
    FakeLauncher,
    FakePromptDeliverer,
    FakePromptActivityObserver,
) {
    let store = Arc::new(SqliteDomainStore::open(database_path).await.unwrap());
    let agent_conversation_service = Arc::new(agent_conversation::AgentConversationService::new(
        Arc::clone(&store),
    ));
    let agent_conversation_runtimes =
        Arc::new(agent_conversation_api::AgentConversationRuntimeRegistry::default());
    let agent_conversations = Arc::new(agent_conversation_api::AgentConversationApi::new(
        agent_conversation_service,
        Arc::clone(&agent_conversation_runtimes),
    ));
    let root = database_path.parent().unwrap().to_path_buf();
    let credential_profiles = Arc::new(
        provider_credential_profile::ProviderCredentialProfileRegistry::new(
            root,
            Arc::clone(&store),
        ),
    );
    let launcher = FakeLauncher::new(Vec::new());
    let prompt_deliverer = FakePromptDeliverer::new(vec![DeliveryOutcome::Succeed]);
    let prompt_activity_observer =
        FakePromptActivityObserver::new(vec![ActivityOutcome::Observed("9")]);
    let reopened = ServiceState {
        scope_id: state.scope_id.clone(),
        slack: crate::slack_connector::SlackConnectorService::new(
            ensure_backend_root(database_path.parent().unwrap()).unwrap().durable(),
            database_path.parent().unwrap(),
            database_path.parent().unwrap().join("dure.mjs"),
            state.hmux_identity.clone(),
        ),
        browser: crate::browser_service::BrowserService::new(
            ensure_backend_root(database_path.parent().unwrap()).unwrap(),
            &state.descriptor.generation,
            database_path.parent().unwrap(),
        ),
        descriptor: state.descriptor.clone(),
        canonical_descriptor_path: state.canonical_descriptor_path.clone(),
        projects_catalog_path: state.projects_catalog_path.clone(),
        agent_providers: Arc::clone(&state.agent_providers),
        runtime_adapters: Arc::new(runtime_extension::local_hmux_runtime_registry(
            state.hmux_identity.clone(),
        )),
        credential_aware_workflow_launcher: Arc::new(launcher.clone()),
        workflow_prompt_deliverer: Arc::new(prompt_deliverer.clone()),
        workflow_prompt_activity_observer: Arc::new(prompt_activity_observer.clone()),
        workspace_acquirer: Arc::new(workspace_git::GitWorkspaceAcquirer::default()),
        hmux_identity: state.hmux_identity.clone(),
        store,
        credential_profiles,
        claude_runtime: None,
        structured_runtimes: Arc::new(
            structured_provider_runtime::StructuredProviderRuntimeRegistry::default(),
        ),
        agent_conversation_runtimes,
        agent_conversations,
        agent_operations: agent_operation_lock::AgentOperationLocks::default(),
        agent_runtime_recovery_wake: Notify::new(),
        goal_wakeup: Notify::new(),
        runtime_idle: Default::default(),
        project_catalog_lock: Mutex::new(()),
        workflow_lock: Mutex::new(()),
        request_slots: Arc::new(Semaphore::new(1)),
        subscription_slots: Arc::new(Semaphore::new(1)),
        connection_slots: Arc::new(Semaphore::new(1)),
        shutdown: Notify::new(),
    };
    (
        reopened,
        launcher,
        prompt_deliverer,
        prompt_activity_observer,
    )
}

fn receipt(value: &Value) -> DelegateOnceReceiptV1 {
    serde_json::from_value(value["receipt"].clone()).unwrap()
}

const LEGACY_EXACT_CONVERSATION: &str = "conversation-legacy-exact";

fn legacy_source_authority_fixture() -> SourceLaunchAuthorityFixture {
    SourceLaunchAuthorityFixture {
        include_rehost_recipe: true,
        launch_reference: Some("codex-test".into()),
        launch_profile_directory_name: Some("codex-test".into()),
        conversation_id: Some(LEGACY_EXACT_CONVERSATION.into()),
        agent_provider_id: ProviderIdV1::new("codex").unwrap(),
        ..SourceLaunchAuthorityFixture::default()
    }
}

async fn register_legacy_test_credential(root: &TempDir, state: &ServiceState) {
    let accounts = root.path().join("accounts");
    fs::create_dir_all(&accounts).unwrap();
    fs::set_permissions(&accounts, fs::Permissions::from_mode(0o700)).unwrap();
    let profile_directory = accounts.join("codex-test");
    fs::create_dir_all(&profile_directory).unwrap();
    fs::set_permissions(&profile_directory, fs::Permissions::from_mode(0o700)).unwrap();
    let _profile = state
        .credential_profiles
        .register(
            provider_credential_profile::RegisterProviderCredentialProfileBodyV1 {
                schema_version: PROVIDER_CREDENTIAL_PROFILE_SCHEMA_VERSION_V1,
                provider_id: "codex".into(),
                reference_id: "acc-test".into(),
                profile_directory_name: "codex-test".into(),
            },
        )
        .await
        .unwrap();
}

fn legacy_binding_body(root: &TempDir) -> BindingEnsureBody {
    BindingEnsureBody {
        schema_version: 1,
        agent_id: AgentIdV1::new("coordinator-1").unwrap(),
        session_id: "coordinator-session".into(),
        workspace_id: "coordinator-workspace".into(),
        display_name: "Coordinator".into(),
        worktree_path: root.path().to_string_lossy().into_owned(),
        stop_fence: HmuxStopFence {
            runner_principal: "coordinator-runner".into(),
            runner_instance: "coordinator-instance".into(),
            channel_epoch: "1".into(),
            host_instance_id: "coordinator-host".into(),
            terminal_epoch: "coordinator-terminal".into(),
        },
    }
}

fn binding_ensure_request(
    state: &ServiceState,
    request_id: &str,
    body: &BindingEnsureBody,
) -> BackendRequest {
    BackendRequest {
        schema_version: 1,
        api_version: BACKEND_PROTOCOL_API.into(),
        kind: BACKEND_REQUEST_KIND.into(),
        request_id: request_id.into(),
        operation: "agent_checkpoint.binding.ensure".into(),
        expected: ExpectedBackend {
            scope_id: None,
            backend_id: BACKEND_ID.into(),
            generation: state.descriptor.generation.clone(),
            protocol: ExpectedProtocol {
                minimum: ProtocolVersion { major: 1, minor: 0 },
                maximum: ProtocolVersion { major: 1, minor: 0 },
            },
            required_capabilities: Vec::new(),
        },
        body: json!({
            "schemaVersion": body.schema_version,
            "agentId": body.agent_id,
            "sessionId": body.session_id,
            "workspaceId": body.workspace_id,
            "displayName": body.display_name,
            "worktreePath": body.worktree_path,
            "stopFence": {
                "runnerPrincipal": body.stop_fence.runner_principal,
                "runnerInstance": body.stop_fence.runner_instance,
                "channelEpoch": body.stop_fence.channel_epoch,
                "hostInstanceId": body.stop_fence.host_instance_id,
                "terminalEpoch": body.stop_fence.terminal_epoch,
            },
        }),
        connection: None,
    }
}

#[tokio::test]
async fn legacy_exact_native_binding_recovers_without_inventing_credential_generation() {
    let (root, state, _, _, _) = fixture_with_source_launch_authority(
        Vec::new(),
        vec![DeliveryOutcome::Succeed],
        vec![ActivityOutcome::Observed("9")],
        HmuxPermissionMode::BypassApprovals,
        "coordinator-terminal",
        legacy_source_authority_fixture(),
    )
    .await;
    register_legacy_test_credential(&root, &state).await;
    let binding = legacy_binding_body(&root);
    let agent_id = binding.agent_id.clone();

    let first = ensure_binding(&state, binding.clone()).await.unwrap();
    assert_eq!(first["identity"]["bindingGeneration"], 2);
    let selection = state
        .store
        .agent_runtime_selection(&agent_id)
        .await
        .unwrap()
        .expect("an exact legacy Hmux authority must become backend-managed");
    assert_eq!(
        selection.interaction_profile,
        AgentInteractionProfileV1::NativeCli
    );
    assert_eq!(
        selection.execution_profile,
        AgentExecutionProfileV1::CredentialReference {
            reference_id: "acc-test".into(),
            credential_generation: None,
        }
    );
    assert_eq!(
        selection.permission_mode,
        ProviderPermissionModeV1::SkipPermissions
    );
    assert_eq!(selection.revision, 1);
    assert_eq!(selection.selected_by_operation_id, None);

    let second = ensure_binding(&state, binding.clone()).await.unwrap();
    assert_eq!(second, first);
    assert_eq!(
        state
            .store
            .agent_runtime_selection(&agent_id)
            .await
            .unwrap()
            .unwrap(),
        selection
    );
    let observation = agent_runtime_transition_apply::inspect(
        &state,
        agent_runtime_transition_apply::AgentRuntimeInspectBodyV1 {
            schema_version: 1,
            agent_id: agent_id.clone(),
        },
    )
    .await
    .unwrap();
    let observation = serde_json::to_value(observation).unwrap();
    assert_eq!(observation["state"], "stable");
    assert_eq!(observation["receipt"]["selectionRevision"], 1);
    assert_eq!(
        observation["receipt"]["providerConversationRef"],
        LEGACY_EXACT_CONVERSATION
    );
    assert_eq!(
        observation["receipt"]["authority"]["authority"]["binding"]["providerConversationId"],
        LEGACY_EXACT_CONVERSATION
    );
    let authority = state
        .store
        .agent_checkpoint_binding_authority(&agent_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        authority.binding.credential_reference_id.as_deref(),
        Some("acc-test")
    );
    assert_eq!(
        authority.binding.provider_conversation_id.as_deref(),
        Some(LEGACY_EXACT_CONVERSATION)
    );
    assert_eq!(authority.binding.binding_generation, 2);
}

#[tokio::test]
async fn legacy_rehost_binding_moves_the_hidden_dispatch_without_a_second_run() {
    let (root, state, launcher, prompt_deliverer, _) = fixture_with_source_launch_authority(
        Vec::new(),
        vec![DeliveryOutcome::Succeed],
        vec![ActivityOutcome::Observed("9")],
        HmuxPermissionMode::BypassApprovals,
        "coordinator-terminal",
        legacy_source_authority_fixture(),
    )
    .await;
    register_legacy_test_credential(&root, &state).await;
    let created = invoke_orchestration(
        &state,
        "run-create-before-legacy-rehost-adoption",
        "run.create",
        existing_session_run_body(),
    )
    .await;
    let source: WorkflowSessionGenerationV1 =
        serde_json::from_value(existing_session_run_body()["session"].clone()).unwrap();
    let target = WorkflowSessionGenerationV1 {
        session_id: "coordinator-session-rehosted".into(),
        workspace_id: source.workspace_id.clone(),
        provider_id: source.provider_id.clone(),
        runner_principal: source.runner_principal.clone(),
        runner_instance: "coordinator-instance-rehosted".into(),
        channel_epoch: "2".into(),
        host_instance_id: "coordinator-host-rehosted".into(),
        terminal_epoch: "coordinator-terminal-rehosted".into(),
    };
    let discovery_root = root.path().join("discovery");
    fs::write(
        discovery_root.join("current-session.json"),
        serde_json::to_vec(&json!({
            "schema_version": 1,
            "session_id": target.session_id,
            "workspace_id": target.workspace_id,
            "session_class": "managed",
            "lifecycle": "ready",
            "provider_id": target.provider_id,
            "runner_principal": target.runner_principal,
            "runner_instance": target.runner_instance,
            "channel_epoch": target.channel_epoch,
            "host_instance_id": target.host_instance_id,
            "terminal_epoch": target.terminal_epoch,
            "health": "healthy",
            "providerConversationIdentity": {
                "session_id": target.session_id,
                "workspace_id": target.workspace_id,
                "runner_principal": target.runner_principal,
                "runner_instance": target.runner_instance,
                "channel_epoch": target.channel_epoch,
                "host_instance_id": target.host_instance_id,
                "terminal_epoch": target.terminal_epoch,
                "provider_id": target.provider_id,
                "conversation_id": LEGACY_EXACT_CONVERSATION,
            }
        }))
        .unwrap(),
    )
    .unwrap();
    let rehost_resolution_path = discovery_root.join("rehost-resolution.json");
    let rehost_resolution = json!({
        "schema": "hmux-managed-rehost-resolution-v1",
        "schemaVersion": 1,
        "state": "resolved",
        "operationIds": ["legacy-rehost-operation-1"],
        "sourceGeneration": source,
        "currentGeneration": target,
        "providerId": "codex",
        "permissionMode": "bypass_approvals",
    });
    fs::write(
        &rehost_resolution_path,
        serde_json::to_vec(&rehost_resolution).unwrap(),
    )
    .unwrap();
    let target_binding = BindingEnsureBody {
        schema_version: 1,
        agent_id: AgentIdV1::new("coordinator-1").unwrap(),
        session_id: target.session_id.clone(),
        workspace_id: target.workspace_id.clone(),
        display_name: "Coordinator".into(),
        worktree_path: root.path().to_string_lossy().into_owned(),
        stop_fence: HmuxStopFence {
            runner_principal: target.runner_principal.clone(),
            runner_instance: target.runner_instance.clone(),
            channel_epoch: target.channel_epoch.clone(),
            host_instance_id: target.host_instance_id.clone(),
            terminal_epoch: target.terminal_epoch.clone(),
        },
    };

    let binding_request =
        binding_ensure_request(&state, "legacy-rehost-binding-ensure", &target_binding);
    let source_authority = state
        .store
        .agent_checkpoint_binding_authority(&target_binding.agent_id)
        .await
        .unwrap()
        .unwrap();
    let launch_count = launcher.requests().len();
    let delivery_count = prompt_deliverer.requests().len();
    let missing_launch_evidence = dispatch(&state, &binding_request).await.unwrap_err();
    assert_eq!(
        missing_launch_evidence.code,
        "agent_checkpoint_binding_launch_authority_unavailable"
    );
    assert_eq!(
        missing_launch_evidence.disposition,
        BackendFailureDispositionV1::RetrySame
    );
    assert_eq!(
        state
            .store
            .agent_checkpoint_binding_authority(&target_binding.agent_id)
            .await
            .unwrap(),
        Some(source_authority.clone())
    );
    assert_eq!(
        state
            .store
            .agent_runtime_selection(&target_binding.agent_id)
            .await
            .unwrap(),
        None
    );
    complete_fixture_managed_rehost_create(
        &state,
        &source,
        &target,
        "coordinator-create-rehosted",
        HmuxPermissionMode::BypassApprovals,
    );
    fs::write(
        &rehost_resolution_path,
        serde_json::to_vec(&json!({
            "schema": "hmux-managed-rehost-resolution-v1",
            "schemaVersion": 1,
            "state": "not_found",
            "source": {
                "sessionId": source.session_id,
                "workspaceId": source.workspace_id,
            }
        }))
        .unwrap(),
    )
    .unwrap();
    let unrelated_lineage = dispatch(&state, &binding_request).await.unwrap_err();
    assert_eq!(
        unrelated_lineage.code,
        "agent_checkpoint_binding_launch_authority_stale"
    );
    assert_eq!(
        unrelated_lineage.disposition,
        BackendFailureDispositionV1::Terminal
    );
    assert_eq!(
        state
            .store
            .agent_checkpoint_binding_authority(&target_binding.agent_id)
            .await
            .unwrap(),
        Some(source_authority.clone())
    );
    fs::write(
        &rehost_resolution_path,
        serde_json::to_vec(&json!({
            "schema": "hmux-managed-rehost-resolution-v1",
            "schemaVersion": 1,
            "state": "retry_required",
            "code": "hmux_managed_rehost_retry_required",
            "operationId": "legacy-rehost-operation-1",
            "source": {
                "sessionId": source.session_id,
                "workspaceId": source.workspace_id,
            }
        }))
        .unwrap(),
    )
    .unwrap();
    let retry_required = dispatch(&state, &binding_request).await.unwrap_err();
    assert_eq!(
        retry_required.code,
        "agent_checkpoint_binding_launch_authority_unavailable"
    );
    assert_eq!(
        retry_required.disposition,
        BackendFailureDispositionV1::RetrySame
    );
    assert_eq!(
        state
            .store
            .agent_checkpoint_binding_authority(&target_binding.agent_id)
            .await
            .unwrap(),
        Some(source_authority.clone())
    );
    fs::write(
        &rehost_resolution_path,
        serde_json::to_vec(&rehost_resolution).unwrap(),
    )
    .unwrap();
    let mut mismatched_resolution = rehost_resolution.clone();
    mismatched_resolution["permissionMode"] = json!("default");
    fs::write(
        &rehost_resolution_path,
        serde_json::to_vec(&mismatched_resolution).unwrap(),
    )
    .unwrap();
    let mismatch = dispatch(&state, &binding_request).await.unwrap_err();
    assert_eq!(
        mismatch.code,
        "agent_checkpoint_binding_launch_authority_stale"
    );
    assert_eq!(mismatch.disposition, BackendFailureDispositionV1::Terminal);
    assert_eq!(
        state
            .store
            .agent_checkpoint_binding_authority(&target_binding.agent_id)
            .await
            .unwrap(),
        Some(source_authority.clone())
    );
    assert_eq!(
        state
            .store
            .agent_runtime_selection(&target_binding.agent_id)
            .await
            .unwrap(),
        None
    );
    fs::write(
        &rehost_resolution_path,
        serde_json::to_vec(&rehost_resolution).unwrap(),
    )
    .unwrap();
    let fault_pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(root.path().join("domain.sqlite")),
    )
    .await
    .unwrap();
    sqlx::query(
        r#"
        CREATE TRIGGER fail_legacy_native_adoption_selection
        BEFORE INSERT ON agent_runtime_selections
        WHEN NEW.agent_id = 'coordinator-1'
        BEGIN
            SELECT RAISE(ABORT, 'fault-injected initial native selection');
        END
        "#,
    )
    .execute(&fault_pool)
    .await
    .unwrap();
    let fault = dispatch(&state, &binding_request).await.unwrap_err();
    assert_eq!(fault.code, "agent_checkpoint_binding_store_failed");
    assert_eq!(fault.disposition, BackendFailureDispositionV1::RetrySame);
    assert_eq!(
        state
            .store
            .agent_checkpoint_binding_authority(&target_binding.agent_id)
            .await
            .unwrap(),
        Some(source_authority)
    );
    assert_eq!(
        state
            .store
            .agent_runtime_selection(&target_binding.agent_id)
            .await
            .unwrap(),
        None
    );
    let rolled_back = invoke_orchestration(
        &state,
        "legacy-rehost-context-after-rollback",
        "dispatch.context.get.batch",
        json!({ "schemaVersion": 1, "sessions": [source.clone(), target.clone()] }),
    )
    .await;
    assert_eq!(rolled_back["receipt"]["results"][0]["outcome"], "found");
    assert_eq!(
        rolled_back["receipt"]["results"][0]["context"],
        created["receipt"]["context"]
    );
    assert_eq!(rolled_back["receipt"]["results"][1]["outcome"], "failed");
    assert_eq!(
        rolled_back["receipt"]["results"][1]["error"]["details"]["disposition"],
        "unassigned"
    );
    sqlx::query("DROP TRIGGER fail_legacy_native_adoption_selection")
        .execute(&fault_pool)
        .await
        .unwrap();
    fault_pool.close().await;

    let binding = dispatch(&state, &binding_request).await.unwrap();
    assert_eq!(binding["identity"]["bindingGeneration"], 2);
    let mut expected_context = created["receipt"]["context"].clone();
    expected_context["endpointFence"]["sessionIdentity"] =
        serde_json::to_value(orchestration_session_identity(&target).unwrap()).unwrap();
    let mut first_context = None;
    for attempt in 0..2 {
        let batch = invoke_orchestration(
            &state,
            &format!("legacy-rehost-context-batch-{attempt}"),
            "dispatch.context.get.batch",
            json!({ "schemaVersion": 1, "sessions": [target.clone()] }),
        )
        .await;
        assert_eq!(batch["receipt"]["results"][0]["outcome"], "found");
        assert_eq!(
            batch["receipt"]["results"][0]["context"]["target"],
            created["receipt"]["context"]["target"]
        );
        assert_eq!(
            batch["receipt"]["results"][0]["session"],
            serde_json::to_value(&target).unwrap()
        );
        let context = batch["receipt"]["results"][0]["context"].clone();
        assert_eq!(context, expected_context);
        assert_eq!(
            context["endpointFence"]["sessionIdentity"],
            serde_json::to_value(orchestration_session_identity(&target).unwrap()).unwrap()
        );
        match &first_context {
            Some(first) => assert_eq!(&context, first),
            None => first_context = Some(context),
        }
    }
    let selection = state
        .store
        .agent_runtime_selection(&target_binding.agent_id)
        .await
        .unwrap()
        .unwrap();
    let target_authority = state
        .store
        .agent_checkpoint_binding_authority(&target_binding.agent_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(selection.revision, 1);
    assert_eq!(selection.selected_by_operation_id, None);
    assert_eq!(target_authority.binding.binding_generation, 2);
    assert_eq!(
        WorkflowSessionGenerationV1::from_checkpoint_authority(
            &target_authority,
            &selection.provider_id,
        ),
        target
    );
    let opened = invoke_orchestration(
        &state,
        "legacy-rehost-open-message",
        "interaction.message.open.exact-session",
        json!({
            "schemaVersion": 1,
            "session": target.clone(),
            "expectedEndpointRef": expected_context["endpointFence"]["endpointRef"],
            "idempotencyKey": "legacy-rehost-open-message",
            "interactionId": "legacy-rehost-message-1",
            "title": "Report the rebound context",
            "descriptionMarkdown": "The rebound worker can report through its durable context.",
            "openedAtMs": 1_100,
        }),
    )
    .await;
    assert_eq!(opened["receipt"]["interaction"]["kind"], "message");
    assert_eq!(opened["receipt"]["deliveries"].as_array().unwrap().len(), 1);
    assert_eq!(
        opened["receipt"]["deliveries"][0]["endpoint"]["sessionIdentity"],
        expected_context["endpointFence"]["sessionIdentity"]
    );
    let after_message = invoke_orchestration(
        &state,
        "legacy-rehost-context-before-completion",
        "dispatch.context.get.batch",
        json!({ "schemaVersion": 1, "sessions": [target.clone()] }),
    )
    .await;
    let completion_context = &after_message["receipt"]["results"][0]["context"];
    let completion = invoke_orchestration(
        &state,
        "legacy-rehost-complete",
        "dispatch.complete",
        json!({
            "schemaVersion": 1,
            "idempotencyKey": "legacy-rehost-complete",
            "messageId": "legacy-rehost-completion-message",
            "target": completion_context["target"],
            "expectedDispatchRevision": completion_context["dispatchRevision"],
            "completedBy": completion_context["participant"],
            "endpointFence": completion_context["endpointFence"],
            "audience": { "grants": [completion_context["coordinatorGrant"].clone()] },
            "completionCapability": completion_context["completionCapability"],
            "title": "Rebound reporting complete",
            "resultMarkdown": "The worker reported through the rebound context.",
            "completedAtMs": 1_200,
        }),
    )
    .await;
    assert_eq!(completion["receipt"]["dispatchState"], "completed");
    let stale_source = invoke_orchestration(
        &state,
        "legacy-rehost-stale-source-context",
        "dispatch.context.get.batch",
        json!({ "schemaVersion": 1, "sessions": [source] }),
    )
    .await;
    assert_eq!(stale_source["receipt"]["results"][0]["outcome"], "failed");
    assert_eq!(
        stale_source["receipt"]["results"][0]["error"]["details"]["disposition"],
        "stale_generation"
    );
    let pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new()
            .filename(root.path().join("domain.sqlite"))
            .read_only(true),
    )
    .await
    .unwrap();
    let run_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM workflow_runs WHERE contribution_id = 'workflow.existing-session-reporting'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(run_count, 1);
    pool.close().await;
    assert_eq!(launcher.requests().len(), launch_count);
    assert_eq!(prompt_deliverer.requests().len(), delivery_count + 1);
}

#[tokio::test]
async fn fresh_backend_adopts_one_exact_legacy_runtime_with_its_bootstrap_identity() {
    let (root, state, _, _, _) = fixture_with_source_launch_authority(
        Vec::new(),
        vec![DeliveryOutcome::Succeed],
        vec![ActivityOutcome::Observed("9")],
        HmuxPermissionMode::BypassApprovals,
        "coordinator-terminal",
        legacy_source_authority_fixture(),
    )
    .await;
    let agent_id = AgentIdV1::new("coordinator-1").unwrap();
    let pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(state.store.database_path()),
    )
    .await
    .unwrap();
    for table in [
        "agent_checkpoint_binding_authorities",
        "session_bindings",
        "agents",
    ] {
        sqlx::query(&format!("DELETE FROM {table} WHERE agent_id = ?1"))
            .bind(agent_id.as_str())
            .execute(&pool)
            .await
            .unwrap();
    }
    pool.close().await;
    // One Hmux runtime workspace may contain Agent worktrees below a different
    // project root; those paths describe layout, not checkpoint identity.
    let shared_project_root = root.path().join("shared-project-root");
    fs::create_dir_all(&shared_project_root).unwrap();
    state
        .store
        .upsert_project(&ProjectRecordV1 {
            project_id: ProjectIdV1::new("hmux-project:coordinator-workspace").unwrap(),
            root_path: shared_project_root.to_string_lossy().into_owned(),
            display_name: "Shared runtime workspace".into(),
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .await
        .unwrap();
    register_legacy_test_credential(&root, &state).await;
    let body = legacy_binding_body(&root);

    let first = ensure_binding(&state, body.clone()).await.unwrap();
    assert_eq!(first["identity"]["bindingGeneration"], 1);
    let selection = state
        .store
        .agent_runtime_selection(&agent_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(selection.revision, 1);
    assert_eq!(selection.selected_by_operation_id, None);
    assert_eq!(
        selection.execution_profile,
        AgentExecutionProfileV1::CredentialReference {
            reference_id: "acc-test".into(),
            credential_generation: None,
        }
    );
    let authority = state
        .store
        .agent_checkpoint_binding_authority(&agent_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(authority.binding.binding_generation, 1);
    assert_eq!(
        authority.binding.provider_conversation_id.as_deref(),
        Some(LEGACY_EXACT_CONVERSATION)
    );
    assert_eq!(
        authority.binding.credential_reference_id.as_deref(),
        Some("acc-test")
    );
    let observation = serde_json::to_value(
        agent_runtime_transition_apply::inspect_projection(
            &state,
            agent_runtime_transition_apply::AgentRuntimeInspectBodyV1 {
                schema_version: 1,
                agent_id: agent_id.clone(),
            },
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        observation["projectionContext"]["identity"],
        json!({
            "kind": "checkpoint_bootstrap",
            "runtimeWorkspaceId": "coordinator-workspace",
        })
    );
    assert_eq!(
        agent_runtime_transition_apply::runtime_workspace(&state, &selection)
            .await
            .unwrap(),
        ("coordinator-workspace".into(), root.path().to_path_buf())
    );

    assert_eq!(ensure_binding(&state, body).await.unwrap(), first);
    assert_eq!(
        state
            .store
            .agent_runtime_selection(&agent_id)
            .await
            .unwrap()
            .unwrap(),
        selection
    );
}

#[tokio::test]
async fn legacy_native_selection_recovers_after_binding_only_crash() {
    let (root, state, _, _, _) = fixture_with_source_launch_authority(
        Vec::new(),
        vec![DeliveryOutcome::Succeed],
        vec![ActivityOutcome::Observed("9")],
        HmuxPermissionMode::BypassApprovals,
        "coordinator-terminal",
        legacy_source_authority_fixture(),
    )
    .await;
    register_legacy_test_credential(&root, &state).await;
    let binding = legacy_binding_body(&root);
    let agent_id = binding.agent_id.clone();
    let mut binding_only_authority = state
        .store
        .agent_checkpoint_binding_authority(&agent_id)
        .await
        .unwrap()
        .unwrap();
    binding_only_authority.binding.credential_reference_id = Some("acc-test".into());
    binding_only_authority.binding.provider_conversation_id =
        Some(LEGACY_EXACT_CONVERSATION.into());
    binding_only_authority.binding.binding_generation = 2;
    binding_only_authority.binding.bound_at_ms = 3;
    binding_only_authority.updated_at_ms = 3;
    state
        .store
        .upsert_agent_checkpoint_binding_authority(&binding_only_authority)
        .await
        .unwrap();
    assert_eq!(
        state
            .store
            .agent_runtime_selection(&agent_id)
            .await
            .unwrap(),
        None
    );

    let recovered = ensure_binding(&state, binding).await.unwrap();
    assert_eq!(recovered["identity"]["bindingGeneration"], 2);
    let recovered_selection = state
        .store
        .agent_runtime_selection(&agent_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(recovered_selection.revision, 1);
    assert_eq!(
        recovered_selection.execution_profile,
        AgentExecutionProfileV1::CredentialReference {
            reference_id: "acc-test".into(),
            credential_generation: None,
        }
    );
    assert_eq!(
        state
            .store
            .agent_checkpoint_binding_authority(&agent_id)
            .await
            .unwrap()
            .unwrap()
            .binding
            .binding_generation,
        2
    );
}

#[tokio::test]
async fn legacy_empty_provider_state_does_not_claim_provider_default() {
    let (root, state, _, _, _) = fixture_with_source_launch_authority(
        Vec::new(),
        vec![DeliveryOutcome::Succeed],
        vec![ActivityOutcome::Observed("9")],
        HmuxPermissionMode::Default,
        "coordinator-terminal",
        SourceLaunchAuthorityFixture {
            include_rehost_recipe: true,
            agent_provider_id: ProviderIdV1::new("codex").unwrap(),
            ..SourceLaunchAuthorityFixture::default()
        },
    )
    .await;
    let body = legacy_binding_body(&root);
    let agent_id = body.agent_id.clone();

    let error = dispatch(
        &state,
        &binding_ensure_request(&state, "legacy-unclaimed-provider-default", &body),
    )
    .await
    .unwrap_err();
    assert_eq!(
        error.code,
        "agent_checkpoint_binding_credential_authority_unsupported"
    );
    assert_eq!(error.disposition, BackendFailureDispositionV1::Terminal);
    assert_eq!(
        state
            .store
            .agent_runtime_selection(&agent_id)
            .await
            .unwrap(),
        None
    );
}

#[tokio::test]
async fn explicit_provider_state_removal_proves_provider_default() {
    let provider_state_environment = ProviderStateEnvironment::from_mutations(
        BTreeMap::new(),
        BTreeSet::from(["CODEX_HOME".into(), "CODEX_SQLITE_HOME".into()]),
    )
    .unwrap();
    let (root, state, _, _, _) = fixture_with_source_launch_authority(
        Vec::new(),
        vec![DeliveryOutcome::Succeed],
        vec![ActivityOutcome::Observed("9")],
        HmuxPermissionMode::Default,
        "coordinator-terminal",
        SourceLaunchAuthorityFixture {
            include_rehost_recipe: true,
            provider_state_environment,
            agent_provider_id: ProviderIdV1::new("codex").unwrap(),
            ..SourceLaunchAuthorityFixture::default()
        },
    )
    .await;
    let body = legacy_binding_body(&root);
    let agent_id = body.agent_id.clone();

    ensure_binding(&state, body).await.unwrap();
    assert_eq!(
        state
            .store
            .agent_runtime_selection(&agent_id)
            .await
            .unwrap()
            .unwrap()
            .execution_profile,
        AgentExecutionProfileV1::ProviderDefault
    );
}

#[tokio::test]
async fn legacy_private_provider_state_without_launch_reference_stays_unmanaged() {
    let provider_state_environment = ProviderStateEnvironment::new(BTreeMap::from([(
        "CODEX_HOME".into(),
        "/tmp/legacy-codex-profile".into(),
    )]))
    .unwrap();
    let (root, state, _, _, _) = fixture_with_source_launch_authority(
        Vec::new(),
        vec![DeliveryOutcome::Succeed],
        vec![ActivityOutcome::Observed("9")],
        HmuxPermissionMode::Default,
        "coordinator-terminal",
        SourceLaunchAuthorityFixture {
            include_rehost_recipe: true,
            provider_state_environment,
            agent_provider_id: ProviderIdV1::new("codex").unwrap(),
            ..SourceLaunchAuthorityFixture::default()
        },
    )
    .await;
    let agent_id = AgentIdV1::new("coordinator-1").unwrap();

    let body = legacy_binding_body(&root);
    let error = dispatch(
        &state,
        &binding_ensure_request(&state, "legacy-private-state", &body),
    )
    .await
    .unwrap_err();
    assert_eq!(
        error.code,
        "agent_checkpoint_binding_credential_authority_unsupported"
    );
    assert_eq!(error.disposition, BackendFailureDispositionV1::Terminal);
    assert_eq!(
        state
            .store
            .agent_runtime_selection(&agent_id)
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        state
            .store
            .agent_checkpoint_binding_authority(&agent_id)
            .await
            .unwrap()
            .unwrap()
            .binding
            .binding_generation,
        1
    );
}

#[tokio::test]
async fn legacy_launch_reference_without_its_provider_environment_stays_unmanaged() {
    let (root, state, _, _, _) = fixture_with_source_launch_authority(
        Vec::new(),
        vec![DeliveryOutcome::Succeed],
        vec![ActivityOutcome::Observed("9")],
        HmuxPermissionMode::Default,
        "coordinator-terminal",
        SourceLaunchAuthorityFixture {
            include_rehost_recipe: true,
            launch_reference: Some("codex-test".into()),
            agent_provider_id: ProviderIdV1::new("codex").unwrap(),
            ..SourceLaunchAuthorityFixture::default()
        },
    )
    .await;
    register_legacy_test_credential(&root, &state).await;
    let body = legacy_binding_body(&root);
    let agent_id = body.agent_id.clone();

    let error = dispatch(
        &state,
        &binding_ensure_request(&state, "legacy-environment-mismatch", &body),
    )
    .await
    .unwrap_err();
    assert_eq!(
        error.code,
        "agent_checkpoint_binding_credential_authority_unsupported"
    );
    assert_eq!(error.disposition, BackendFailureDispositionV1::Terminal);
    assert_eq!(
        state
            .store
            .agent_runtime_selection(&agent_id)
            .await
            .unwrap(),
        None
    );
}

#[tokio::test]
async fn legacy_duplicate_runtime_owner_is_a_terminal_binding_conflict() {
    let (root, state, _, _, _) = fixture_with_source_launch_authority(
        Vec::new(),
        vec![DeliveryOutcome::Succeed],
        vec![ActivityOutcome::Observed("9")],
        HmuxPermissionMode::Default,
        "coordinator-terminal",
        SourceLaunchAuthorityFixture {
            agent_provider_id: ProviderIdV1::new("codex").unwrap(),
            ..SourceLaunchAuthorityFixture::default()
        },
    )
    .await;
    let duplicate_agent_id = AgentIdV1::new("legacy-duplicate-owner").unwrap();
    state
        .store
        .upsert_agent(&AgentRecordV1 {
            agent_id: duplicate_agent_id.clone(),
            workspace_id: WorkspaceIdV1::new("workspace-1").unwrap(),
            provider_id: ProviderIdV1::new("codex").unwrap(),
            display_name: "Legacy duplicate".into(),
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .await
        .unwrap();
    let mut duplicate = state
        .store
        .agent_checkpoint_binding_authority(&AgentIdV1::new("coordinator-1").unwrap())
        .await
        .unwrap()
        .unwrap();
    duplicate.binding.agent_id = duplicate_agent_id;
    let pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(state.store.database_path()),
    )
    .await
    .unwrap();
    sqlx::query(
        r#"
        INSERT INTO session_bindings (
            agent_id, runtime_kind_id, session_id, provider_conversation_id,
            credential_reference_id, binding_generation, bound_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        "#,
    )
    .bind(duplicate.binding.agent_id.as_str())
    .bind(duplicate.binding.runtime_kind_id.as_str())
    .bind(&duplicate.binding.session_id)
    .bind(&duplicate.binding.provider_conversation_id)
    .bind(&duplicate.binding.credential_reference_id)
    .bind(duplicate.binding.binding_generation)
    .bind(duplicate.binding.bound_at_ms)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        r#"
        INSERT INTO agent_checkpoint_binding_authorities (
            agent_id, schema_version, session_id, runtime_workspace_id,
            runner_principal, runner_instance, channel_epoch, host_instance_id,
            terminal_epoch, binding_generation, updated_at_ms
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
        "#,
    )
    .bind(duplicate.binding.agent_id.as_str())
    .bind(i64::from(duplicate.schema_version))
    .bind(&duplicate.binding.session_id)
    .bind(&duplicate.runtime_workspace_id)
    .bind(&duplicate.runner_principal)
    .bind(&duplicate.runner_instance)
    .bind(&duplicate.channel_epoch)
    .bind(&duplicate.host_instance_id)
    .bind(&duplicate.terminal_epoch)
    .bind(duplicate.binding.binding_generation)
    .bind(duplicate.updated_at_ms)
    .execute(&pool)
    .await
    .unwrap();
    pool.close().await;

    let body = legacy_binding_body(&root);
    let error = dispatch(
        &state,
        &binding_ensure_request(&state, "legacy-duplicate-owner", &body),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "agent_checkpoint_binding_runtime_owned");
    assert_eq!(error.disposition, BackendFailureDispositionV1::Terminal);
    assert_eq!(
        state
            .store
            .agent_runtime_selection(&body.agent_id)
            .await
            .unwrap(),
        None
    );
}

#[tokio::test]
async fn selected_native_runtime_binding_only_accepts_its_current_authority() {
    let agent_id = AgentIdV1::new("selected-runtime-agent").unwrap();
    let (root, state, _, _, _) = fixture_with_source_launch_authority(
        Vec::new(),
        vec![DeliveryOutcome::Succeed],
        vec![ActivityOutcome::Observed("9")],
        HmuxPermissionMode::Default,
        "coordinator-terminal",
        SourceLaunchAuthorityFixture {
            agent_id: agent_id.clone(),
            credential_reference_id: Some("hebbian98".into()),
            agent_provider_id: ProviderIdV1::new("codex").unwrap(),
            ..SourceLaunchAuthorityFixture::default()
        },
    )
    .await;
    state
        .store
        .initialize_agent_runtime_selection(&AgentRuntimeSelectionV1 {
            schema_version: 1,
            agent_id: agent_id.clone(),
            provider_id: ProviderIdV1::new("codex").unwrap(),
            interaction_profile: AgentInteractionProfileV1::NativeCli,
            execution_profile: AgentExecutionProfileV1::CredentialReference {
                reference_id: "hebbian98".into(),
                credential_generation: Some("credential-hebbian98-1".into()),
            },
            permission_mode: ProviderPermissionModeV1::Default,
            model: None,
            effort: None,
            revision: 1,
            selected_by_operation_id: None,
            updated_at_ms: 2,
        })
        .await
        .unwrap();
    let current = BindingEnsureBody {
        schema_version: 1,
        agent_id: agent_id.clone(),
        session_id: "coordinator-session".into(),
        workspace_id: "coordinator-workspace".into(),
        display_name: "Coordinator".into(),
        worktree_path: root.path().to_string_lossy().into_owned(),
        stop_fence: HmuxStopFence {
            runner_principal: "coordinator-runner".into(),
            runner_instance: "coordinator-instance".into(),
            channel_epoch: "1".into(),
            host_instance_id: "coordinator-host".into(),
            terminal_epoch: "coordinator-terminal".into(),
        },
    };

    let identity = ensure_binding(&state, current.clone()).await.unwrap();
    assert_eq!(identity["identity"]["sessionId"], "coordinator-session");
    assert_eq!(identity["identity"]["bindingGeneration"], 1);

    let mut rogue = current;
    rogue.session_id = "managed-rehost-rogue".into();
    assert_eq!(
        ensure_binding(&state, rogue).await.unwrap_err(),
        "agent_checkpoint_binding_runtime_owned"
    );
    let authority = state
        .store
        .agent_checkpoint_binding_authority(&agent_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(authority.binding.session_id, "coordinator-session");
    assert_eq!(authority.binding.binding_generation, 1);
}

#[tokio::test]
async fn native_credential_replacement_persists_the_advanced_successor_and_journaled_target() {
    let (root, mut state, launcher, _) =
        fixture(vec![LaunchOutcome::AdvancedAfterProviderPathExists {
            session_id: "advanced-native-session",
            launch_idempotency_key: "advanced-native-create-key",
            relative_path: "packages/standalone/current/codex",
        }])
        .await;
    let canonical_codex_home = root.path().join(".codex");
    let canonical_standalone = canonical_codex_home.join("packages/standalone/current");
    fs::create_dir_all(&canonical_standalone).unwrap();
    fs::write(canonical_standalone.join("codex"), b"fixture codex").unwrap();
    let accounts = root.path().join("accounts");
    fs::create_dir(&accounts).unwrap();
    fs::set_permissions(&accounts, fs::Permissions::from_mode(0o700)).unwrap();
    let profile_directory = accounts.join("codex-account-b");
    fs::create_dir(&profile_directory).unwrap();
    fs::set_permissions(&profile_directory, fs::Permissions::from_mode(0o700)).unwrap();
    let registered = state
        .credential_profiles
        .register(
            provider_credential_profile::RegisterProviderCredentialProfileBodyV1 {
                schema_version: PROVIDER_CREDENTIAL_PROFILE_SCHEMA_VERSION_V1,
                provider_id: "codex".into(),
                reference_id: "account-b".into(),
                profile_directory_name: "codex-account-b".into(),
            },
        )
        .await
        .unwrap();

    let agent_id = AgentIdV1::new("native-credential-agent").unwrap();
    let provider_id = ProviderIdV1::new("codex").unwrap();
    state
        .store
        .upsert_agent(&AgentRecordV1 {
            agent_id: agent_id.clone(),
            workspace_id: WorkspaceIdV1::new("workspace-1").unwrap(),
            provider_id: provider_id.clone(),
            display_name: "Native credential agent".into(),
            created_at_ms: 2,
            updated_at_ms: 2,
        })
        .await
        .unwrap();
    let source_authority = AgentCheckpointBindingAuthorityV1 {
        schema_version: AGENT_CHECKPOINT_SCHEMA_VERSION_V1,
        binding: SessionBindingRecordV1 {
            agent_id: agent_id.clone(),
            runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
            session_id: "native-account-a-session".into(),
            provider_conversation_id: Some("native-account-conversation".into()),
            credential_reference_id: Some("account-a".into()),
            binding_generation: 1,
            bound_at_ms: 10,
        },
        runtime_workspace_id: "workspace-1".into(),
        runner_principal: "account-a-runner".into(),
        runner_instance: "account-a-instance".into(),
        channel_epoch: "1".into(),
        host_instance_id: "account-a-host".into(),
        terminal_epoch: "account-a-terminal".into(),
        updated_at_ms: 10,
    };
    state
        .store
        .upsert_agent_checkpoint_binding_authority(&source_authority)
        .await
        .unwrap();
    let source = AgentRuntimeSelectionV1 {
        schema_version: 1,
        agent_id: agent_id.clone(),
        provider_id: provider_id.clone(),
        interaction_profile: AgentInteractionProfileV1::NativeCli,
        execution_profile: AgentExecutionProfileV1::CredentialReference {
            reference_id: "account-a".into(),
            credential_generation: Some("account-a-generation".into()),
        },
        permission_mode: ProviderPermissionModeV1::Default,
        model: None,
        effort: None,
        revision: 1,
        selected_by_operation_id: None,
        updated_at_ms: 10,
    };
    state
        .store
        .initialize_agent_runtime_selection(&source)
        .await
        .unwrap();
    let attempt_id = "native-credential-a-to-b";
    let (operation_id, _) =
        agent_runtime_transition_apply::runtime_transition_identity(attempt_id).unwrap();

    let digest = format!(
        "{:x}",
        Sha256::digest(
            format!(
                "dure-agent-runtime-native-target/v1\0{}",
                operation_id.as_str()
            )
            .as_bytes()
        )
    );
    let requested_target_session_id = format!("runtime-native-{}", &digest[..32]);
    let advanced_target_session_id = "advanced-native-session";
    let source_inspection = json!({
        "schema_version": 1,
        "session_id": "native-account-a-session",
        "workspace_id": "workspace-1",
        "session_class": "managed",
        "lifecycle": "ready",
        "provider_id": "codex",
        "runner_principal": "account-a-runner",
        "runner_instance": "account-a-instance",
        "channel_epoch": "1",
        "host_instance_id": "account-a-host",
        "terminal_epoch": "account-a-terminal",
        "output_seq": "0",
        "health": "healthy",
        "agentRuntimeState": {
            "terminal_epoch": "account-a-terminal",
            "revision": "1",
            "observed_through_output_seq": "0",
            "lifecycle": "running",
            "activity": "waiting",
            "attention": "none",
            "attention_id": null
        },
        "providerConversationIdentity": {
            "session_id": "native-account-a-session",
            "workspace_id": "workspace-1",
            "runner_principal": "account-a-runner",
            "runner_instance": "account-a-instance",
            "channel_epoch": "1",
            "host_instance_id": "account-a-host",
            "terminal_epoch": "account-a-terminal",
            "provider_id": "codex",
            "conversation_id": "native-account-conversation"
        }
    });
    let target_inspection = json!({
        "schema_version": 1,
        "session_id": advanced_target_session_id,
        "workspace_id": "workspace-1",
        "session_class": "managed",
        "lifecycle": "ready",
        "provider_id": "codex",
        "runner_principal": "worker-runner",
        "runner_instance": "worker-instance",
        "channel_epoch": "2",
        "host_instance_id": "worker-host",
        "terminal_epoch": "worker-terminal",
        "output_seq": "0",
        "health": "healthy",
        "providerConversationIdentity": {
            "session_id": advanced_target_session_id,
            "workspace_id": "workspace-1",
            "runner_principal": "worker-runner",
            "runner_instance": "worker-instance",
            "channel_epoch": "2",
            "host_instance_id": "worker-host",
            "terminal_epoch": "worker-terminal",
            "provider_id": "codex",
            "conversation_id": "native-account-conversation"
        }
    });
    let hmux = state.hmux_identity.executable_path.clone();
    fs::write(
        &hmux,
        format!(
            "#!/bin/sh\nif [ \"${{6:-}}\" = \"native-account-a-session\" ]; then printf '%s' '{}'; else printf '%s' '{}'; fi\n",
            source_inspection, target_inspection
        ),
    )
    .unwrap();
    fs::set_permissions(&hmux, fs::Permissions::from_mode(0o700)).unwrap();

    let stop_request = ManagedStopRequest::new(
        agent_runtime_transition_apply::quiescent_stop_identity(&operation_id, 1, 0),
        "native-account-a-session",
        "workspace-1",
    )
    .unwrap()
    .with_expected_fence(
        "account-a-runner",
        "account-a-instance",
        1,
        "account-a-host",
        "account-a-terminal",
    )
    .unwrap()
    .with_expected_conversation(
        ManagedStopConversationFence::new("codex", Some("native-account-conversation".into()))
            .unwrap(),
    )
    .unwrap()
    .with_expected_quiescence(ManagedStopQuiescenceFence::new("account-a-terminal", 1, 0).unwrap())
    .unwrap();
    let stop_receipt = ManagedStopReceipt::from_request(
        &stop_request,
        ManagedStopOutcome::Stopped,
        "fixture exact source stopped",
    )
    .unwrap();
    let reconcile_response = ManagedStopBrokerResponse::refused(
        "hmux_managed_stop_intent_not_found",
        "fixture has no prior stop",
    );
    let completed_response = ManagedStopBrokerResponse::Completed(Box::new(stop_receipt));
    let payload = serde_json::to_vec(&reconcile_response).unwrap();
    let mut encoded = (payload.len() as u32).to_be_bytes().to_vec();
    encoded.extend_from_slice(&payload);
    let reconcile_response_path = root.path().join("stop-reconcile-response.bin");
    fs::write(&reconcile_response_path, encoded).unwrap();
    let payload = serde_json::to_vec(&completed_response).unwrap();
    let mut encoded = (payload.len() as u32).to_be_bytes().to_vec();
    encoded.extend_from_slice(&payload);
    let completed_response_path = root.path().join("stop-completed-response.bin");
    fs::write(&completed_response_path, encoded).unwrap();
    let stop_calls_path = root.path().join("stop-calls");
    let hmux_runtime = state.hmux_identity.runtime_executable_path.clone();
    fs::write(
        &hmux_runtime,
        format!(
            "#!/bin/sh\nif [ \"${{2:-}}\" = \"{}\" ]; then cat '{}'; exit 0; fi\nif [ \"${{2:-}}\" = \"{}\" ]; then printf x >> '{}'; cat '{}'; exit 0; fi\nexit 1\n",
            MANAGED_STOP_RECONCILE_BROKER_SUBCOMMAND,
            reconcile_response_path.display(),
            MANAGED_STOP_BROKER_SUBCOMMAND,
            stop_calls_path.display(),
            completed_response_path.display(),
        ),
    )
    .unwrap();
    fs::set_permissions(&hmux_runtime, fs::Permissions::from_mode(0o700)).unwrap();
    state.hmux_identity =
        resolve_hmux_toolchain_identity(&hmux, &hmux_runtime, &state.hmux_identity.discovery_root)
            .unwrap();

    let preparation_attempts = Arc::new(AtomicUsize::new(0));
    state.credential_profiles = Arc::new(
        provider_credential_profile::ProviderCredentialProfileRegistry::with_launch_preparer(
            root.path().to_path_buf(),
            Arc::clone(&state.store),
            Arc::new(FailOnceProfilePreparer {
                attempts: Arc::clone(&preparation_attempts),
                delegate:
                    provider_credential_profile::NativeProviderCredentialProfileLaunchPreparer::new(
                        root.path().to_path_buf(),
                        Some(root.path().to_path_buf()),
                    ),
            }),
        ),
    );

    let apply_body = agent_runtime_transition_apply::AgentRuntimeTransitionApplyBodyV1 {
        schema_version: 1,
        agent_id: agent_id.clone(),
        target_interaction_profile: AgentInteractionProfileV1::NativeCli,
        expected_source_revision: None,
        source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
        target_execution_profile: Some(AgentExecutionProfileV1::CredentialReference {
            reference_id: registered.reference_id.clone(),
            credential_generation: Some(registered.credential_generation.clone()),
        }),
        target_launch_selection: None,
    };

    let preparation_error =
        agent_runtime_transition_apply::apply(&state, attempt_id, apply_body.clone())
            .await
            .unwrap_err();
    assert_eq!(
        preparation_error.code,
        provider_credential_profile::ProviderCredentialProfileErrorV1::Unavailable.code()
    );
    assert!(launcher.requests().is_empty());
    assert!(!stop_calls_path.exists());

    let applied = agent_runtime_transition_apply::apply(&state, attempt_id, apply_body)
        .await
        .unwrap();
    assert_eq!(preparation_attempts.load(Ordering::SeqCst), 2);
    let applied_value = serde_json::to_value(&applied).unwrap();
    assert_eq!(
        applied_value["launchIdempotencyKey"],
        "advanced-native-create-key"
    );
    let transition = state
        .store
        .agent_runtime_transition(&operation_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        transition.target_launch_idempotency_key.as_deref(),
        Some("advanced-native-create-key")
    );
    let selected = state
        .store
        .agent_runtime_selection(&agent_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        selected.execution_profile,
        AgentExecutionProfileV1::CredentialReference {
            reference_id: registered.reference_id,
            credential_generation: Some(registered.credential_generation),
        }
    );
    let launch_requests = launcher.requests();
    assert_eq!(launch_requests.len(), 1);
    assert_eq!(launch_requests[0].session_id, requested_target_session_id);
    assert_ne!(launch_requests[0].session_id, advanced_target_session_id);
    let presentation_predecessors = launcher.presentation_predecessors();
    let presentation_predecessor = presentation_predecessors[0]
        .as_ref()
        .expect("native replacement must retain the source presentation");
    assert_eq!(
        presentation_predecessor.session_id(),
        source_authority.binding.session_id
    );
    assert_eq!(
        presentation_predecessor.runner_principal(),
        source_authority.runner_principal
    );
    assert_eq!(
        presentation_predecessor.runner_instance(),
        source_authority.runner_instance
    );
    assert_eq!(presentation_predecessor.channel_epoch(), 1);
    assert_eq!(
        presentation_predecessor.host_instance_id(),
        source_authority.host_instance_id
    );
    assert_eq!(
        presentation_predecessor.terminal_epoch(),
        source_authority.terminal_epoch
    );
    assert_eq!(fs::read(&stop_calls_path).unwrap(), b"x");
    let environments = launcher.provider_state_environments();
    assert_eq!(environments.len(), 1);
    assert_eq!(
        environments[0].values().get("CODEX_HOME"),
        Some(
            &profile_directory
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .into_owned()
        )
    );
    let authority = state
        .store
        .agent_checkpoint_binding_authority(&agent_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(authority.binding.session_id, advanced_target_session_id);
    assert_eq!(
        authority.binding.credential_reference_id.as_deref(),
        Some("account-b")
    );
}

fn make_fixture_mutation_authority(state: &mut ServiceState) {
    let descriptor_root = state.canonical_descriptor_path.parent().unwrap();
    state.descriptor.schema_version = 3;
    state.descriptor.socket_path =
        generation_socket_path(descriptor_root, &state.descriptor.generation);
    state.descriptor.database_path = descriptor_root.join("application-state.sqlite3");
    state.descriptor.hmux_executable_device = Some(state.hmux_identity.executable_device.clone());
    state.descriptor.hmux_executable_inode = Some(state.hmux_identity.executable_inode.clone());
    state.descriptor.hmux_executable_size = Some(state.hmux_identity.executable_size.clone());
    state.descriptor.hmux_executable_modified =
        Some(state.hmux_identity.executable_modified.clone());
    state.descriptor.hmux_executable_sha256 = Some(state.hmux_identity.executable_sha256.clone());
    state.descriptor.hmux_runtime_executable_device =
        Some(state.hmux_identity.runtime_executable_device.clone());
    state.descriptor.hmux_runtime_executable_inode =
        Some(state.hmux_identity.runtime_executable_inode.clone());
    state.descriptor.hmux_runtime_executable_size =
        Some(state.hmux_identity.runtime_executable_size.clone());
    state.descriptor.hmux_runtime_executable_modified =
        Some(state.hmux_identity.runtime_executable_modified.clone());
    state.descriptor.hmux_runtime_executable_sha256 =
        Some(state.hmux_identity.runtime_executable_sha256.clone());
    state.descriptor.hmux_discovery_device = Some(state.hmux_identity.discovery_device.clone());
    state.descriptor.hmux_discovery_inode = Some(state.hmux_identity.discovery_inode.clone());
    write_descriptor(&state.canonical_descriptor_path, &state.descriptor).unwrap();
    assert!(state.is_mutation_authority());
}

async fn request_over_test_connection(
    state: Arc<ServiceState>,
    operation: &str,
    capability: &str,
    body: Value,
) -> Value {
    let request = json!({
        "schemaVersion": 1,
        "apiVersion": BACKEND_PROTOCOL_API,
        "kind": BACKEND_REQUEST_KIND,
        "requestId": format!("wire-{}", operation.replace('.', "-")),
        "operation": operation,
        "expected": {
            "backendId": state.descriptor.backend_id,
            "generation": state.descriptor.generation,
            "protocol": {
                "minimum": { "major": 1, "minor": 0 },
                "maximum": { "major": 1, "minor": 0 }
            },
            "requiredCapabilities": [capability]
        },
        "body": body
    });
    let (mut client, server) = UnixStream::pair().unwrap();
    let handled = tokio::spawn(handle_connection(state, server));
    let mut source = serde_json::to_vec(&request).unwrap();
    source.push(b'\n');
    client.write_all(&source).await.unwrap();
    client.shutdown().await.unwrap();
    let mut response = Vec::new();
    client.read_to_end(&mut response).await.unwrap();
    handled.await.unwrap().unwrap();
    serde_json::from_slice(&response).unwrap()
}

#[tokio::test]
async fn replaced_backend_still_serves_durable_observations_but_rejects_mutations() {
    let (_root, state, _launcher, _prompt_deliverer) = fixture(Vec::new()).await;
    let mut replacement = state.descriptor.clone();
    replacement.generation = "local-v1-11111111111111111111111111111111".into();
    write_descriptor(&state.canonical_descriptor_path, &replacement).unwrap();
    assert!(!state.is_mutation_authority());
    let state = Arc::new(state);

    let observation = request_over_test_connection(
        Arc::clone(&state),
        "agent_conversation.inspect",
        "agent_conversation.inspect",
        json!({ "schemaVersion": 1, "agentId": "coordinator-1" }),
    )
    .await;
    assert_eq!(observation["kind"], BACKEND_RESPONSE_KIND);
    assert_eq!(observation["result"]["binding"], Value::Null);

    let mutation = request_over_test_connection(
        state,
        "agent_runtime.transition",
        "agent_runtime.transition",
        json!({ "schemaVersion": 1 }),
    )
    .await;
    assert_eq!(mutation["kind"], BACKEND_ERROR_KIND);
    assert_eq!(mutation["error"]["code"], "recovering");
}

async fn initialize_structured_source(
    state: &ServiceState,
) -> (AgentRuntimeSelectionV1, AgentInteractionBindingV1) {
    initialize_structured_source_for_provider(
        state,
        AgentIdV1::new("coordinator-1").unwrap(),
        ProviderIdV1::new("provider.codex").unwrap(),
    )
    .await
}

async fn initialize_structured_source_for_provider(
    state: &ServiceState,
    agent_id: AgentIdV1,
    provider_id: ProviderIdV1,
) -> (AgentRuntimeSelectionV1, AgentInteractionBindingV1) {
    let source = AgentRuntimeSelectionV1 {
        schema_version: 1,
        agent_id: agent_id.clone(),
        provider_id: provider_id.clone(),
        interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        permission_mode: ProviderPermissionModeV1::Default,
        model: None,
        effort: None,
        revision: 1,
        selected_by_operation_id: None,
        updated_at_ms: 10,
    };
    state
        .store
        .initialize_agent_runtime_selection(&source)
        .await
        .unwrap();
    let binding = AgentInteractionBindingV1 {
        schema_version: 1,
        interaction_session_id: AgentInteractionSessionIdV1::new("interaction-retained").unwrap(),
        agent_id: agent_id.clone(),
        provider_id: provider_id.clone(),
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        provider_conversation_ref: Some("conversation-retained".into()),
        runtime: AgentProviderRuntimeFenceV1 {
            runtime_generation: "runtime-retained".into(),
            provider_epoch: "provider-retained".into(),
        },
        timeline_epoch: AgentTimelineEpochV1::new("timeline-retained").unwrap(),
        binding_revision: 1,
        history_complete: true,
        created_at_ms: 10,
        updated_at_ms: 10,
    };
    state
        .store
        .create_agent_interaction(&binding)
        .await
        .unwrap();
    (source, binding)
}

async fn admit_structured_to_native_transition(state: &ServiceState) -> (AgentIdV1, ProviderIdV1) {
    let (source, binding) = initialize_structured_source(state).await;
    let agent_id = source.agent_id.clone();
    let provider_id = source.provider_id.clone();
    state
        .store
        .admit_agent_runtime_transition(&AgentRuntimeTransitionIntentV1 {
            schema_version: 1,
            operation_id: OperationIdV1::new("transition-retained-source").unwrap(),
            idempotency_key: "transition-retained-source-key".into(),
            source,
            source_authority: AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding },
            source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
            provider_conversation_ref: dure_app::AgentProviderConversationPlanV1::resume(
                "conversation-retained",
            )
            .unwrap(),
            target_interaction_profile: AgentInteractionProfileV1::NativeCli,
            target_execution_profile: AgentExecutionProfileV1::ProviderDefault,
            target_launch_selection: None,
            requested_at_ms: 20,
        })
        .await
        .unwrap();
    (agent_id, provider_id)
}

async fn admit_structured_credential_transition(
    state: &ServiceState,
) -> (AgentIdV1, ProviderIdV1, OperationIdV1) {
    let agent_id = AgentIdV1::new("runtime-repair-agent").unwrap();
    let provider_id = ProviderIdV1::new("codex").unwrap();
    let accounts = state
        .descriptor
        .database_path
        .parent()
        .unwrap()
        .join("accounts");
    fs::create_dir_all(&accounts).unwrap();
    fs::set_permissions(&accounts, fs::Permissions::from_mode(0o700)).unwrap();
    let profile_directory = accounts.join("codex-runtime-repair");
    fs::create_dir_all(&profile_directory).unwrap();
    fs::set_permissions(&profile_directory, fs::Permissions::from_mode(0o700)).unwrap();
    let credential = state
        .credential_profiles
        .register(
            provider_credential_profile::RegisterProviderCredentialProfileBodyV1 {
                schema_version: PROVIDER_CREDENTIAL_PROFILE_SCHEMA_VERSION_V1,
                provider_id: provider_id.as_str().into(),
                reference_id: "runtime-repair-account".into(),
                profile_directory_name: "codex-runtime-repair".into(),
            },
        )
        .await
        .unwrap();
    state
        .store
        .upsert_agent(&AgentRecordV1 {
            agent_id: agent_id.clone(),
            workspace_id: WorkspaceIdV1::new("workspace-1").unwrap(),
            provider_id: provider_id.clone(),
            display_name: "Runtime repair agent".into(),
            created_at_ms: 2,
            updated_at_ms: 2,
        })
        .await
        .unwrap();
    let (source, binding) =
        initialize_structured_source_for_provider(state, agent_id, provider_id).await;
    let agent_id = source.agent_id.clone();
    let provider_id = source.provider_id.clone();
    let operation_id = OperationIdV1::new("transition-repair-required").unwrap();
    state
        .store
        .admit_agent_runtime_transition(&AgentRuntimeTransitionIntentV1 {
            schema_version: 1,
            operation_id: operation_id.clone(),
            idempotency_key: "transition-repair-required-key".into(),
            source,
            source_authority: AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding },
            source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
            provider_conversation_ref: dure_app::AgentProviderConversationPlanV1::resume(
                "conversation-retained",
            )
            .unwrap(),
            target_interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
            target_execution_profile: AgentExecutionProfileV1::CredentialReference {
                reference_id: credential.reference_id,
                credential_generation: Some(credential.credential_generation),
            },
            target_launch_selection: None,
            requested_at_ms: 20,
        })
        .await
        .unwrap();
    (agent_id, provider_id, operation_id)
}

async fn park_structured_credential_transition(
    state: &ServiceState,
) -> (AgentIdV1, ProviderIdV1, AgentRuntimeTransitionRecordV1) {
    let (agent_id, provider_id, operation_id) = admit_structured_credential_transition(state).await;
    let admitted = state
        .store
        .agent_runtime_transition(&operation_id)
        .await
        .unwrap()
        .unwrap();
    let stopped = state
        .store
        .advance_agent_runtime_transition(&AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: 1,
            operation_id: operation_id.clone(),
            expected_journal_revision: admitted.journal_revision,
            advance: AgentRuntimeTransitionAdvanceV1::SourceStopped,
            advanced_at_ms: 30,
        })
        .await
        .unwrap();
    let parked = state
        .store
        .advance_agent_runtime_transition(&AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: 1,
            operation_id,
            expected_journal_revision: stopped.journal_revision,
            advance: AgentRuntimeTransitionAdvanceV1::RepairRequired {
                failure: AgentRuntimeTargetFailureV1::new(
                    AgentRuntimeTargetFailureKindV1::CredentialUnavailable,
                    "fixture_credential_unavailable",
                )
                .unwrap(),
                replacement_authority: AgentRuntimeReplacementAuthorityUpdateV1::PreserveExisting,
            },
            advanced_at_ms: 40,
        })
        .await
        .unwrap();
    (agent_id, provider_id, parked)
}

async fn admit_structured_close(state: &ServiceState) -> (AgentIdV1, ProviderIdV1, OperationIdV1) {
    let (source, binding) = initialize_structured_source(state).await;
    let agent_id = source.agent_id.clone();
    let provider_id = source.provider_id.clone();
    let operation_id = OperationIdV1::new("close-retained-source").unwrap();
    state
        .store
        .admit_agent_runtime_close(&AgentRuntimeCloseIntentV1 {
            schema_version: 1,
            operation_id: operation_id.clone(),
            idempotency_key: "close-retained-source-key".into(),
            source,
            source_authority: AgentRuntimeBindingAuthorityV1::StructuredProtocol { binding },
            stopped_transition: None,
            requested_at_ms: 20,
        })
        .await
        .unwrap();
    (agent_id, provider_id, operation_id)
}

#[tokio::test]
async fn native_transition_converges_a_missing_conversation_from_exact_hmux_identity() {
    let (_root, mut state, _, _) = fixture(Vec::new()).await;
    let hmux = state.hmux_identity.executable_path.clone();
    let ready = json!({
        "schema_version": 1,
        "session_id": "codex-convergence-session",
        "workspace_id": "codex-convergence-workspace",
        "session_class": "managed",
        "lifecycle": "ready",
        "provider_id": "codex",
        "runner_principal": "codex-convergence-runner",
        "runner_instance": "codex-convergence-instance",
        "channel_epoch": "7",
        "host_instance_id": "codex-convergence-host",
        "terminal_epoch": "codex-convergence-terminal",
        "output_seq": "19",
        "health": "healthy",
        "agentRuntimeState": {
            "terminal_epoch": "codex-convergence-terminal",
            "revision": "4",
            "observed_through_output_seq": "19",
            "lifecycle": "running",
            "activity": "waiting",
            "attention": "none",
            "attention_id": null
        },
        "providerConversationIdentity": {
            "session_id": "codex-convergence-session",
            "workspace_id": "codex-convergence-workspace",
            "runner_principal": "codex-convergence-runner",
            "runner_instance": "codex-convergence-instance",
            "channel_epoch": "7",
            "host_instance_id": "codex-convergence-host",
            "terminal_epoch": "codex-convergence-terminal",
            "provider_id": "codex",
            "conversation_id": "conversation-codex-converged"
        }
    });
    let mut exited = ready.clone();
    exited["lifecycle"] = json!("exited");
    exited["health"] = json!("exited");
    exited["agentRuntimeState"] = Value::Null;
    fs::write(hmux.with_extension("inspection-ready"), ready.to_string()).unwrap();
    fs::write(hmux.with_extension("inspection-exited"), exited.to_string()).unwrap();
    fs::write(
        &hmux,
        "#!/bin/sh\ncount=0\nif [ -f \"$0.inspect-count\" ]; then count=$(cat \"$0.inspect-count\"); fi\ncount=$((count + 1))\nprintf '%s' \"$count\" > \"$0.inspect-count\"\nif [ \"$count\" -eq 1 ]; then exec cat \"$0.inspection-ready\"; fi\nexec cat \"$0.inspection-exited\"\n",
    )
    .unwrap();
    fs::set_permissions(&hmux, fs::Permissions::from_mode(0o700)).unwrap();
    state.hmux_identity = resolve_hmux_toolchain_identity(
        &hmux,
        &state.hmux_identity.runtime_executable_path,
        &state.hmux_identity.discovery_root,
    )
    .unwrap();
    state.agent_providers =
        Arc::new(provider_extension::test_codex_structured_agent_provider_registry());
    let mut runtimes = structured_provider_runtime::StructuredProviderRuntimeRegistry::default();
    let provider_id = ProviderIdV1::new("codex").unwrap();
    runtimes
        .register(
            provider_id.clone(),
            Arc::new(CountingStructuredRuntime {
                supports_new_sessions: true,
                attach_count: Arc::new(AtomicUsize::new(0)),
                attach_error: None,
            }),
        )
        .unwrap();
    state.structured_runtimes = Arc::new(runtimes);

    let agent_id = AgentIdV1::new("codex-convergence-agent").unwrap();
    state
        .store
        .upsert_agent(&AgentRecordV1 {
            agent_id: agent_id.clone(),
            workspace_id: WorkspaceIdV1::new("workspace-1").unwrap(),
            provider_id: provider_id.clone(),
            display_name: "Codex convergence".into(),
            created_at_ms: 10,
            updated_at_ms: 10,
        })
        .await
        .unwrap();
    let source_authority = AgentCheckpointBindingAuthorityV1 {
        schema_version: AGENT_CHECKPOINT_SCHEMA_VERSION_V1,
        binding: SessionBindingRecordV1 {
            agent_id: agent_id.clone(),
            runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
            session_id: "codex-convergence-session".into(),
            provider_conversation_id: None,
            credential_reference_id: None,
            binding_generation: 7,
            bound_at_ms: 10,
        },
        runtime_workspace_id: "codex-convergence-workspace".into(),
        runner_principal: "codex-convergence-runner".into(),
        runner_instance: "codex-convergence-instance".into(),
        channel_epoch: "7".into(),
        host_instance_id: "codex-convergence-host".into(),
        terminal_epoch: "codex-convergence-terminal".into(),
        updated_at_ms: 10,
    };
    state
        .store
        .upsert_agent_checkpoint_binding_authority(&source_authority)
        .await
        .unwrap();
    state
        .store
        .initialize_agent_runtime_selection(&AgentRuntimeSelectionV1 {
            schema_version: 1,
            agent_id: agent_id.clone(),
            provider_id,
            interaction_profile: AgentInteractionProfileV1::NativeCli,
            execution_profile: AgentExecutionProfileV1::ProviderDefault,
            permission_mode: ProviderPermissionModeV1::Default,
            model: None,
            effort: None,
            revision: 1,
            selected_by_operation_id: None,
            updated_at_ms: 10,
        })
        .await
        .unwrap();

    let error = agent_runtime_transition_apply::apply(
        &state,
        "codex-convergence-attempt",
        agent_runtime_transition_apply::AgentRuntimeTransitionApplyBodyV1 {
            schema_version: 1,
            agent_id: agent_id.clone(),
            target_interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
            expected_source_revision: None,
            source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
            target_execution_profile: None,
            target_launch_selection: None,
        },
    )
    .await
    .unwrap_err();

    assert_eq!(error.code, "counting_structured_runtime_unavailable");
    let mut expected_authority = source_authority;
    expected_authority.binding.provider_conversation_id =
        Some("conversation-codex-converged".into());
    assert_eq!(
        state
            .store
            .agent_checkpoint_binding_authority(&agent_id)
            .await
            .unwrap(),
        Some(expected_authority.clone()),
        "exact Hmux identity must fill only the missing conversation field"
    );
    let transition = state
        .store
        .active_agent_runtime_transition(&agent_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        transition.state,
        AgentRuntimeTransitionStateV1::SourceStopped
    );
    assert_eq!(
        transition.intent.provider_conversation_ref.as_option(),
        Some("conversation-codex-converged")
    );
    assert_eq!(
        transition.intent.source_authority,
        AgentRuntimeBindingAuthorityV1::NativeCli {
            authority: expected_authority,
        }
    );
}

#[tokio::test]
async fn native_transition_refreshes_quiescence_after_an_idle_redraw_refuses_stop() {
    let (_root, mut state, _, _) = fixture(Vec::new()).await;
    let hmux = state.hmux_identity.executable_path.clone();
    let hmux_runtime = state.hmux_identity.runtime_executable_path.clone();
    let first_inspection = json!({
        "schema_version": 1,
        "session_id": "coordinator-session",
        "workspace_id": "coordinator-workspace",
        "session_class": "managed",
        "lifecycle": "ready",
        "provider_id": "provider.codex",
        "runner_principal": "coordinator-runner",
        "runner_instance": "coordinator-instance",
        "channel_epoch": "1",
        "host_instance_id": "coordinator-host",
        "terminal_epoch": "coordinator-terminal",
        "output_seq": "80",
        "health": "healthy",
        "agentRuntimeState": {
            "terminal_epoch": "coordinator-terminal",
            "revision": "3",
            "observed_through_output_seq": "80",
            "lifecycle": "running",
            "activity": "waiting",
            "attention": "none",
            "attention_id": null
        },
        "providerConversationIdentity": {
            "session_id": "coordinator-session",
            "workspace_id": "coordinator-workspace",
            "runner_principal": "coordinator-runner",
            "runner_instance": "coordinator-instance",
            "channel_epoch": "1",
            "host_instance_id": "coordinator-host",
            "terminal_epoch": "coordinator-terminal",
            "provider_id": "provider.codex",
            "conversation_id": "conversation-redraw"
        }
    });
    let mut second_inspection = first_inspection.clone();
    second_inspection["output_seq"] = json!("82");
    second_inspection["agentRuntimeState"]["observed_through_output_seq"] = json!("82");
    fs::write(
        hmux.with_extension("inspection-1"),
        first_inspection.to_string(),
    )
    .unwrap();
    fs::write(
        hmux.with_extension("inspection-2"),
        second_inspection.to_string(),
    )
    .unwrap();
    fs::write(
        &hmux,
        "#!/bin/sh\ncount=0\nif [ -f \"$0.inspect-count\" ]; then count=$(cat \"$0.inspect-count\"); fi\ncount=$((count + 1))\nprintf '%s' \"$count\" > \"$0.inspect-count\"\nif [ \"$count\" -eq 1 ]; then exec cat \"$0.inspection-1\"; fi\nexec cat \"$0.inspection-2\"\n",
    )
    .unwrap();
    fs::set_permissions(&hmux, fs::Permissions::from_mode(0o700)).unwrap();

    fs::write(
        &hmux_runtime,
        format!(
            "#!/bin/sh\ncase \"$2\" in\n  {MANAGED_STOP_RECONCILE_BROKER_SUBCOMMAND})\n    cat > /dev/null\n    exec cat \"$0.reconcile\"\n    ;;\n  {MANAGED_STOP_BROKER_SUBCOMMAND})\n    count=0\n    if [ -f \"$0.stop-count\" ]; then count=$(cat \"$0.stop-count\"); fi\n    count=$((count + 1))\n    printf '%s' \"$count\" > \"$0.stop-count\"\n    cat > \"$0.stop-request-$count\"\n    exec cat \"$0.stop-$count\"\n    ;;\n  *) exit 64 ;;\nesac\n"
        ),
    )
    .unwrap();
    fs::set_permissions(&hmux_runtime, fs::Permissions::from_mode(0o700)).unwrap();

    let write_broker_frame = |path: &std::path::Path, response: &ManagedStopBrokerResponse| {
        let payload = serde_json::to_vec(response).unwrap();
        let mut frame = (payload.len() as u32).to_be_bytes().to_vec();
        frame.extend(payload);
        fs::write(path, frame).unwrap();
    };
    write_broker_frame(
        &hmux_runtime.with_extension("reconcile"),
        &ManagedStopBrokerResponse::refused(
            "hmux_managed_stop_intent_not_found",
            "no prior stop intent",
        ),
    );
    write_broker_frame(
        &hmux_runtime.with_extension("stop-1"),
        &ManagedStopBrokerResponse::refused(
            "hmux_managed_stop_fence_mismatch",
            "idle redraw advanced output",
        ),
    );

    let operation_id = OperationIdV1::new("transition-native-idle-redraw").unwrap();
    let second_stop_request = ManagedStopRequest::new(
        agent_runtime_transition_apply::quiescent_stop_identity(&operation_id, 3, 82),
        "coordinator-session",
        "coordinator-workspace",
    )
    .and_then(|request| {
        request.with_expected_fence(
            "coordinator-runner",
            "coordinator-instance",
            1,
            "coordinator-host",
            "coordinator-terminal",
        )
    })
    .and_then(|request| {
        request.with_expected_quiescence(ManagedStopQuiescenceFence::new(
            "coordinator-terminal",
            3,
            82,
        )?)
    })
    .unwrap();
    write_broker_frame(
        &hmux_runtime.with_extension("stop-2"),
        &ManagedStopBrokerResponse::Completed(Box::new(
            ManagedStopReceipt::from_request(
                &second_stop_request,
                ManagedStopOutcome::Stopped,
                "test source stopped",
            )
            .unwrap(),
        )),
    );
    state.hmux_identity =
        resolve_hmux_toolchain_identity(&hmux, &hmux_runtime, &state.hmux_identity.discovery_root)
            .unwrap();

    let agent_id = AgentIdV1::new("coordinator-1").unwrap();
    let source_authority = AgentCheckpointBindingAuthorityV1 {
        schema_version: AGENT_CHECKPOINT_SCHEMA_VERSION_V1,
        binding: SessionBindingRecordV1 {
            agent_id: agent_id.clone(),
            runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
            session_id: "coordinator-session".into(),
            provider_conversation_id: Some("conversation-redraw".into()),
            credential_reference_id: None,
            binding_generation: 2,
            bound_at_ms: 10,
        },
        runtime_workspace_id: "coordinator-workspace".into(),
        runner_principal: "coordinator-runner".into(),
        runner_instance: "coordinator-instance".into(),
        channel_epoch: "1".into(),
        host_instance_id: "coordinator-host".into(),
        terminal_epoch: "coordinator-terminal".into(),
        updated_at_ms: 10,
    };
    state
        .store
        .upsert_agent_checkpoint_binding_authority(&source_authority)
        .await
        .unwrap();
    let source = AgentRuntimeSelectionV1 {
        schema_version: 1,
        agent_id,
        provider_id: ProviderIdV1::new("provider.codex").unwrap(),
        interaction_profile: AgentInteractionProfileV1::NativeCli,
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        permission_mode: ProviderPermissionModeV1::Default,
        model: None,
        effort: None,
        revision: 1,
        selected_by_operation_id: None,
        updated_at_ms: 10,
    };
    state
        .store
        .initialize_agent_runtime_selection(&source)
        .await
        .unwrap();
    let transition = state
        .store
        .admit_agent_runtime_transition(&AgentRuntimeTransitionIntentV1 {
            schema_version: 1,
            operation_id,
            idempotency_key: "transition-native-idle-redraw-key".into(),
            source,
            source_authority: AgentRuntimeBindingAuthorityV1::NativeCli {
                authority: source_authority,
            },
            source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
            provider_conversation_ref: dure_app::AgentProviderConversationPlanV1::resume(
                "conversation-redraw",
            )
            .unwrap(),
            target_interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
            target_execution_profile: AgentExecutionProfileV1::ProviderDefault,
            target_launch_selection: None,
            requested_at_ms: 20,
        })
        .await
        .unwrap();

    let drive_error = match agent_runtime_transition_apply::drive_locked(&state, transition).await {
        Ok(_) => panic!("the absent structured target must leave the stopped transition pending"),
        Err(error) => error,
    };
    assert_eq!(drive_error, "agent_runtime_structured_profile_unavailable");
    assert_eq!(
        state
            .store
            .active_agent_runtime_transition(&AgentIdV1::new("coordinator-1").unwrap(),)
            .await
            .unwrap()
            .unwrap()
            .state,
        AgentRuntimeTransitionStateV1::SourceStopped,
        "an idle redraw must refresh quiescence instead of retaining the source"
    );
    assert_eq!(
        fs::read_to_string(hmux.with_extension("inspect-count")).unwrap(),
        "2"
    );
    assert_eq!(
        fs::read_to_string(hmux_runtime.with_extension("stop-count")).unwrap(),
        "2"
    );
    let read_stop_request = |path: &std::path::Path| {
        let frame = fs::read(path).unwrap();
        let payload_len = u32::from_be_bytes(frame[..4].try_into().unwrap()) as usize;
        assert_eq!(payload_len, frame.len() - 4);
        serde_json::from_slice::<ManagedStopRequest>(&frame[4..]).unwrap()
    };
    let first_request = read_stop_request(&hmux_runtime.with_extension("stop-request-1"));
    let second_request = read_stop_request(&hmux_runtime.with_extension("stop-request-2"));
    assert_eq!(
        first_request
            .expected_quiescence()
            .unwrap()
            .observed_through_output_seq(),
        80
    );
    assert_eq!(
        second_request
            .expected_quiescence()
            .unwrap()
            .observed_through_output_seq(),
        82
    );
    assert_ne!(first_request.stop_id(), second_request.stop_id());
}

#[tokio::test]
async fn native_transition_same_quiescence_refusal_is_not_replayed() {
    let (_root, mut state, _, _) = fixture(Vec::new()).await;
    let hmux = state.hmux_identity.executable_path.clone();
    let hmux_runtime = state.hmux_identity.runtime_executable_path.clone();
    let inspection = json!({
        "schema_version": 1,
        "session_id": "coordinator-session",
        "workspace_id": "coordinator-workspace",
        "session_class": "managed",
        "lifecycle": "ready",
        "provider_id": "provider.codex",
        "runner_principal": "coordinator-runner",
        "runner_instance": "coordinator-instance",
        "channel_epoch": "1",
        "host_instance_id": "coordinator-host",
        "terminal_epoch": "coordinator-terminal",
        "output_seq": "80",
        "health": "healthy",
        "agentRuntimeState": {
            "terminal_epoch": "coordinator-terminal",
            "revision": "3",
            "observed_through_output_seq": "80",
            "lifecycle": "running",
            "activity": "waiting",
            "attention": "none",
            "attention_id": null
        },
        "providerConversationIdentity": {
            "session_id": "coordinator-session",
            "workspace_id": "coordinator-workspace",
            "runner_principal": "coordinator-runner",
            "runner_instance": "coordinator-instance",
            "channel_epoch": "1",
            "host_instance_id": "coordinator-host",
            "terminal_epoch": "coordinator-terminal",
            "provider_id": "provider.codex",
            "conversation_id": "conversation-retained-input"
        }
    });
    fs::write(hmux.with_extension("inspection"), inspection.to_string()).unwrap();
    fs::write(&hmux, "#!/bin/sh\nexec cat \"$0.inspection\"\n").unwrap();
    fs::set_permissions(&hmux, fs::Permissions::from_mode(0o700)).unwrap();

    fs::write(
        &hmux_runtime,
        "#!/bin/sh\ncount=0\nif [ -f \"$0.stop-count\" ]; then count=$(cat \"$0.stop-count\"); fi\ncount=$((count + 1))\nprintf '%s' \"$count\" > \"$0.stop-count\"\ncat > /dev/null\nif [ \"$count\" -eq 1 ]; then exec cat \"$0.refused\"; fi\nexec cat \"$0.completed\"\n",
    )
    .unwrap();
    fs::set_permissions(&hmux_runtime, fs::Permissions::from_mode(0o700)).unwrap();
    let write_broker_frame = |path: &std::path::Path, response: &ManagedStopBrokerResponse| {
        let payload = serde_json::to_vec(response).unwrap();
        let mut frame = (payload.len() as u32).to_be_bytes().to_vec();
        frame.extend(payload);
        fs::write(path, frame).unwrap();
    };
    let response = ManagedStopBrokerResponse::refused(
        "hmux_managed_stop_fence_mismatch",
        "source retained controller input",
    );
    write_broker_frame(&hmux_runtime.with_extension("refused"), &response);
    let preserve_operation = OperationIdV1::new("transition-native-retained-input").unwrap();
    let preserve_request = ManagedStopRequest::new(
        agent_runtime_transition_apply::quiescent_stop_identity(&preserve_operation, 3, 80),
        "coordinator-session",
        "coordinator-workspace",
    )
    .and_then(|request| {
        request.with_expected_fence(
            "coordinator-runner",
            "coordinator-instance",
            1,
            "coordinator-host",
            "coordinator-terminal",
        )
    })
    .and_then(|request| {
        request.with_expected_quiescence(ManagedStopQuiescenceFence::new(
            "coordinator-terminal",
            3,
            80,
        )?)
    })
    .unwrap();
    write_broker_frame(
        &hmux_runtime.with_extension("completed"),
        &ManagedStopBrokerResponse::Completed(Box::new(
            ManagedStopReceipt::from_request(
                &preserve_request,
                ManagedStopOutcome::Stopped,
                "a replay would incorrectly stop the retained source",
            )
            .unwrap(),
        )),
    );
    state.hmux_identity =
        resolve_hmux_toolchain_identity(&hmux, &hmux_runtime, &state.hmux_identity.discovery_root)
            .unwrap();

    let agent_id = AgentIdV1::new("coordinator-1").unwrap();
    let source_authority = AgentCheckpointBindingAuthorityV1 {
        schema_version: AGENT_CHECKPOINT_SCHEMA_VERSION_V1,
        binding: SessionBindingRecordV1 {
            agent_id: agent_id.clone(),
            runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
            session_id: "coordinator-session".into(),
            provider_conversation_id: Some("conversation-retained-input".into()),
            credential_reference_id: None,
            binding_generation: 2,
            bound_at_ms: 10,
        },
        runtime_workspace_id: "coordinator-workspace".into(),
        runner_principal: "coordinator-runner".into(),
        runner_instance: "coordinator-instance".into(),
        channel_epoch: "1".into(),
        host_instance_id: "coordinator-host".into(),
        terminal_epoch: "coordinator-terminal".into(),
        updated_at_ms: 10,
    };
    state
        .store
        .upsert_agent_checkpoint_binding_authority(&source_authority)
        .await
        .unwrap();
    let source = AgentRuntimeSelectionV1 {
        schema_version: 1,
        agent_id: agent_id.clone(),
        provider_id: ProviderIdV1::new("provider.codex").unwrap(),
        interaction_profile: AgentInteractionProfileV1::NativeCli,
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        permission_mode: ProviderPermissionModeV1::Default,
        model: None,
        effort: None,
        revision: 1,
        selected_by_operation_id: None,
        updated_at_ms: 10,
    };
    state
        .store
        .initialize_agent_runtime_selection(&source)
        .await
        .unwrap();
    let transition = state
        .store
        .admit_agent_runtime_transition(&AgentRuntimeTransitionIntentV1 {
            schema_version: 1,
            operation_id: preserve_operation,
            idempotency_key: "transition-native-retained-input-key".into(),
            source: source.clone(),
            source_authority: AgentRuntimeBindingAuthorityV1::NativeCli {
                authority: source_authority.clone(),
            },
            source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
            provider_conversation_ref: dure_app::AgentProviderConversationPlanV1::resume(
                "conversation-retained-input",
            )
            .unwrap(),
            target_interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
            target_execution_profile: AgentExecutionProfileV1::ProviderDefault,
            target_launch_selection: None,
            requested_at_ms: 20,
        })
        .await
        .unwrap();

    let outcome = agent_runtime_transition_apply::drive_locked(&state, transition)
        .await
        .unwrap();
    assert!(matches!(
        outcome,
        agent_runtime_transition_apply::TransitionDriveOutcome::SourceRetained
    ));
    assert_eq!(
        fs::read_to_string(hmux_runtime.with_extension("stop-count")).unwrap(),
        "1",
        "the same definitive refusal must not be replayed"
    );

    fs::write(
        &hmux_runtime,
        format!(
            "#!/bin/sh\ncase \"$2\" in\n  {MANAGED_STOP_RECONCILE_BROKER_SUBCOMMAND})\n    cat > /dev/null\n    exec cat \"$0.discard-reconcile\"\n    ;;\n  {MANAGED_STOP_BROKER_SUBCOMMAND})\n    count=0\n    if [ -f \"$0.discard-stop-count\" ]; then count=$(cat \"$0.discard-stop-count\"); fi\n    count=$((count + 1))\n    printf '%s' \"$count\" > \"$0.discard-stop-count\"\n    cat > \"$0.discard-stop-request\"\n    exec cat \"$0.discard-stop\"\n    ;;\n  *) exit 64 ;;\nesac\n"
        ),
    )
    .unwrap();
    fs::set_permissions(&hmux_runtime, fs::Permissions::from_mode(0o700)).unwrap();
    state.hmux_identity =
        resolve_hmux_toolchain_identity(&hmux, &hmux_runtime, &state.hmux_identity.discovery_root)
            .unwrap();
    write_broker_frame(
        &hmux_runtime.with_extension("discard-reconcile"),
        &ManagedStopBrokerResponse::refused(
            "hmux_managed_stop_intent_not_found",
            "no prior discard stop intent",
        ),
    );
    let discard_operation = OperationIdV1::new("transition-native-discard-input").unwrap();
    let discard_request = ManagedStopRequest::new(
        agent_runtime_transition_apply::stop_identity(&discard_operation, 0),
        "coordinator-session",
        "coordinator-workspace",
    )
    .and_then(|request| {
        request.with_expected_fence(
            "coordinator-runner",
            "coordinator-instance",
            1,
            "coordinator-host",
            "coordinator-terminal",
        )
    })
    .and_then(|request| {
        request.with_expected_conversation(
            ManagedStopConversationFence::new(
                "provider.codex",
                Some("conversation-retained-input".into()),
            )
            .unwrap(),
        )
    })
    .unwrap();
    write_broker_frame(
        &hmux_runtime.with_extension("discard-stop"),
        &ManagedStopBrokerResponse::Completed(Box::new(
            ManagedStopReceipt::from_request(
                &discard_request,
                ManagedStopOutcome::Stopped,
                "test explicitly discarded source",
            )
            .unwrap(),
        )),
    );
    assert_eq!(
        state
            .store
            .agent_checkpoint_binding_authority(&agent_id)
            .await
            .unwrap(),
        Some(source_authority.clone())
    );
    let discard_transition = state
        .store
        .admit_agent_runtime_transition(&AgentRuntimeTransitionIntentV1 {
            schema_version: 1,
            operation_id: discard_operation.clone(),
            idempotency_key: "transition-native-discard-input-key".into(),
            source,
            source_authority: AgentRuntimeBindingAuthorityV1::NativeCli {
                authority: source_authority.clone(),
            },
            source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Discard,
            provider_conversation_ref: dure_app::AgentProviderConversationPlanV1::resume(
                "conversation-retained-input",
            )
            .unwrap(),
            target_interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
            target_execution_profile: AgentExecutionProfileV1::ProviderDefault,
            target_launch_selection: None,
            requested_at_ms: 21,
        })
        .await
        .unwrap();
    let open_count = Arc::new(AtomicUsize::new(0));
    let mut runtimes = structured_provider_runtime::StructuredProviderRuntimeRegistry::default();
    runtimes
        .register(
            ProviderIdV1::new("provider.codex").unwrap(),
            Arc::new(RepairableReplacementRuntime {
                store: Arc::clone(&state.store),
                stop_count: Arc::new(AtomicUsize::new(0)),
                open_count: Arc::clone(&open_count),
                first_failure_kind:
                    structured_provider_runtime::StructuredProviderRuntimeErrorKindV1::CredentialUnavailable,
                second_failure_kind: None,
                succeed_on_retry: false,
            }),
        )
        .unwrap();
    state.structured_runtimes = Arc::new(runtimes);
    let discard_result =
        agent_runtime_transition_apply::drive_locked(&state, discard_transition).await;
    assert!(
        hmux_runtime.with_extension("discard-stop-count").exists(),
        "explicit discard must reach the exact Hmux stop boundary"
    );
    match discard_result {
        Ok(agent_runtime_transition_apply::TransitionDriveOutcome::SourceRetained) => {
            panic!("explicit discard unexpectedly retained the exact source")
        }
        Ok(agent_runtime_transition_apply::TransitionDriveOutcome::Committed(_)) => {
            panic!("the fixture unexpectedly supplied a structured target")
        }
        Ok(agent_runtime_transition_apply::TransitionDriveOutcome::RepairRequired) => {}
        Ok(agent_runtime_transition_apply::TransitionDriveOutcome::Superseded) => {
            panic!("a fresh transition cannot already be superseded")
        }
        Ok(agent_runtime_transition_apply::TransitionDriveOutcome::Deferred) => {
            panic!("an immediate discard transition cannot defer its target")
        }
        Err(error) => panic!("target failure was not durably parked: {error}"),
    }
    assert_eq!(
        state
            .store
            .active_agent_runtime_transition(&agent_id)
            .await
            .unwrap()
            .unwrap()
            .state,
        AgentRuntimeTransitionStateV1::RepairRequired
    );
    assert_eq!(
        fs::read_to_string(hmux_runtime.with_extension("discard-stop-count")).unwrap(),
        "1"
    );
    assert_eq!(
        open_count.load(Ordering::SeqCst),
        1,
        "the stopped transition must start its target exactly once"
    );
    let frame = fs::read(hmux_runtime.with_extension("discard-stop-request")).unwrap();
    let payload_len = u32::from_be_bytes(frame[..4].try_into().unwrap()) as usize;
    let actual_request: ManagedStopRequest = serde_json::from_slice(&frame[4..]).unwrap();
    assert_eq!(payload_len, frame.len() - 4);
    assert_eq!(actual_request, discard_request);
    assert!(actual_request.expected_quiescence().is_none());
}

#[tokio::test]
async fn runtime_recovery_attaches_each_stable_runtime_once_then_sleeps() {
    let (_root, mut state, _, _) = fixture(Vec::new()).await;
    make_fixture_mutation_authority(&mut state);
    let agent_id = AgentIdV1::new("coordinator-1").unwrap();
    let provider_id = ProviderIdV1::new("provider.codex").unwrap();
    let selection = AgentRuntimeSelectionV1 {
        schema_version: 1,
        agent_id: agent_id.clone(),
        provider_id: provider_id.clone(),
        interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        permission_mode: ProviderPermissionModeV1::Default,
        model: None,
        effort: None,
        revision: 1,
        selected_by_operation_id: None,
        updated_at_ms: 10,
    };
    state
        .store
        .initialize_agent_runtime_selection(&selection)
        .await
        .unwrap();
    let binding = AgentInteractionBindingV1 {
        schema_version: 1,
        interaction_session_id: AgentInteractionSessionIdV1::new("interaction-stable").unwrap(),
        agent_id,
        provider_id: provider_id.clone(),
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        provider_conversation_ref: Some("conversation-stable".into()),
        runtime: AgentProviderRuntimeFenceV1 {
            runtime_generation: "runtime-stable".into(),
            provider_epoch: "provider-stable".into(),
        },
        timeline_epoch: AgentTimelineEpochV1::new("timeline-stable").unwrap(),
        binding_revision: 1,
        history_complete: true,
        created_at_ms: 10,
        updated_at_ms: 10,
    };
    state
        .store
        .create_agent_interaction(&binding)
        .await
        .unwrap();
    let attach_count = Arc::new(AtomicUsize::new(0));
    let mut runtimes = structured_provider_runtime::StructuredProviderRuntimeRegistry::default();
    runtimes
        .register(
            provider_id,
            Arc::new(CountingStructuredRuntime {
                supports_new_sessions: false,
                attach_count: Arc::clone(&attach_count),
                attach_error: None,
            }),
        )
        .unwrap();
    state.structured_runtimes = Arc::new(runtimes);
    let state = Arc::new(state);
    let recovery = tokio::spawn(agent_runtime_recovery::run(Arc::clone(&state)));

    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        while attach_count.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("startup recovery must attach the selected structured runtime");
    state.agent_runtime_recovery_wake.notify_one();
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(
        attach_count.load(Ordering::SeqCst),
        1,
        "a wake without an incomplete lifecycle operation must not reattach a converged runtime"
    );

    recovery.abort();
    let _ = recovery.await;
}

#[tokio::test]
async fn runtime_recovery_authority_waits_for_operations_admitted_after_startup() {
    let (_root, mut state, _, _) = fixture(Vec::new()).await;
    make_fixture_mutation_authority(&mut state);
    assert!(
        state
            .store
            .agent_runtime_startup_recovery_candidates()
            .await
            .unwrap()
            .is_empty()
    );
    let state = Arc::new(state);
    let mut recovery = tokio::spawn(agent_runtime_recovery::run(Arc::clone(&state)));

    let completed =
        tokio::time::timeout(std::time::Duration::from_millis(100), &mut recovery).await;
    assert!(
        completed.is_err(),
        "runtime recovery exited before a live service could admit later work"
    );

    let agent_id = AgentIdV1::new("coordinator-1").unwrap();
    let provider_id = ProviderIdV1::new("provider.codex").unwrap();
    let source = AgentRuntimeSelectionV1 {
        schema_version: 1,
        agent_id: agent_id.clone(),
        provider_id: provider_id.clone(),
        interaction_profile: AgentInteractionProfileV1::NativeCli,
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        permission_mode: ProviderPermissionModeV1::Default,
        model: None,
        effort: None,
        revision: 1,
        selected_by_operation_id: None,
        updated_at_ms: 10,
    };
    state
        .store
        .initialize_agent_runtime_selection(&source)
        .await
        .unwrap();
    let native_authority = AgentCheckpointBindingAuthorityV1 {
        schema_version: AGENT_CHECKPOINT_SCHEMA_VERSION_V1,
        binding: SessionBindingRecordV1 {
            agent_id: agent_id.clone(),
            runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
            session_id: "coordinator-session".into(),
            provider_conversation_id: Some("conversation-late".into()),
            credential_reference_id: None,
            binding_generation: 2,
            bound_at_ms: 10,
        },
        runtime_workspace_id: "coordinator-workspace".into(),
        runner_principal: "coordinator-runner".into(),
        runner_instance: "coordinator-instance".into(),
        channel_epoch: "1".into(),
        host_instance_id: "coordinator-host".into(),
        terminal_epoch: "coordinator-terminal".into(),
        updated_at_ms: 10,
    };
    state
        .store
        .upsert_agent_checkpoint_binding_authority(&native_authority)
        .await
        .unwrap();
    let intent = AgentRuntimeTransitionIntentV1 {
        schema_version: 1,
        operation_id: OperationIdV1::new("transition-admitted-late").unwrap(),
        idempotency_key: "transition-admitted-late-key".into(),
        source,
        source_authority: AgentRuntimeBindingAuthorityV1::NativeCli {
            authority: native_authority,
        },
        source_stop_policy: dure_app::AgentRuntimeSourceStopPolicyV1::Preserve,
        provider_conversation_ref: dure_app::AgentProviderConversationPlanV1::resume(
            "conversation-late",
        )
        .unwrap(),
        target_interaction_profile: AgentInteractionProfileV1::StructuredProtocol,
        target_execution_profile: AgentExecutionProfileV1::ProviderDefault,
        target_launch_selection: None,
        requested_at_ms: 20,
    };
    let admitted = state
        .store
        .admit_agent_runtime_transition(&intent)
        .await
        .unwrap();
    let stopped = state
        .store
        .advance_agent_runtime_transition(&AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: 1,
            operation_id: intent.operation_id.clone(),
            expected_journal_revision: admitted.journal_revision,
            advance: AgentRuntimeTransitionAdvanceV1::SourceStopped,
            advanced_at_ms: 30,
        })
        .await
        .unwrap();
    let target_binding = AgentInteractionBindingV1 {
        schema_version: 1,
        interaction_session_id: AgentInteractionSessionIdV1::new("interaction-late").unwrap(),
        agent_id: agent_id.clone(),
        provider_id: provider_id.clone(),
        execution_profile: AgentExecutionProfileV1::ProviderDefault,
        provider_conversation_ref: Some("conversation-late".into()),
        runtime: AgentProviderRuntimeFenceV1 {
            runtime_generation: "runtime-late".into(),
            provider_epoch: "provider-late".into(),
        },
        timeline_epoch: AgentTimelineEpochV1::new("timeline-late").unwrap(),
        binding_revision: 1,
        history_complete: true,
        created_at_ms: 40,
        updated_at_ms: 40,
    };
    state
        .store
        .create_agent_interaction(&target_binding)
        .await
        .unwrap();
    state
        .store
        .advance_agent_runtime_transition(&AgentRuntimeTransitionAdvanceRequestV1 {
            schema_version: 1,
            operation_id: intent.operation_id.clone(),
            expected_journal_revision: stopped.journal_revision,
            advance: AgentRuntimeTransitionAdvanceV1::TargetStarted {
                launch_idempotency_key: None,
                authority: Box::new(AgentRuntimeBindingAuthorityV1::StructuredProtocol {
                    binding: target_binding,
                }),
            },
            advanced_at_ms: 40,
        })
        .await
        .unwrap();
    state.agent_runtime_recovery_wake.notify_one();

    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        loop {
            let transition = state
                .store
                .agent_runtime_transition(&intent.operation_id)
                .await
                .unwrap()
                .unwrap();
            if transition.state == AgentRuntimeTransitionStateV1::Committed {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("a post-startup wake must commit the durable transition");

    recovery.abort();
    let _ = recovery.await;
}

#[tokio::test]
async fn spawn_preview_can_project_the_canonical_root_without_persisting_it_in_the_plan() {
    assert_spawn_preview_can_project_root(true).await;
}

#[tokio::test]
async fn spawn_preview_can_project_a_plain_folder_without_git() {
    assert_spawn_preview_can_project_root(false).await;
}

async fn assert_spawn_preview_can_project_root(with_git: bool) {
    let (root, state, _, _) = fixture(vec![]).await;
    if with_git {
        fs::create_dir(root.path().join(".git")).unwrap();
    }
    let project_root = root.path().canonicalize().unwrap();
    let registered = register_project(
        &state.projects_catalog_path,
        "dure-internal".into(),
        "HebbianIDE".into(),
        project_root.to_string_lossy().into_owned(),
    )
    .unwrap();

    let preview = preview_agent_spawn(
        &state,
        &BackendRequestAuthority {
            backend_id: state.descriptor.backend_id.clone(),
            generation: state.descriptor.generation.clone(),
        },
        &json!({
            "schemaVersion": 1,
            "idempotencyKey": "presentation-project-root-1",
            "includePresentationProject": true,
            "projectId": "dure-internal",
            "providerId": "codex",
            "agentName": "presentation-root",
            "worktree": { "kind": "project_root" },
            "promptDigest": null,
            "interactionPreference": "native_cli",
        }),
    )
    .await
    .unwrap();

    assert_eq!(preview["presentationProject"]["projectId"], "dure-internal");
    assert_eq!(preview["presentationProject"]["rootId"], registered.root_id);
    assert_eq!(
        preview["presentationProject"]["repositoryId"],
        registered.repository_id
    );
    assert_eq!(
        preview["presentationProject"]["root"],
        project_root.to_string_lossy().as_ref()
    );
    assert!(
        preview["receipt"]["plan"]
            .get("presentationProject")
            .is_none()
    );
    assert!(
        preview["receipt"]["plan"]["request"]
            .get("includePresentationProject")
            .is_none()
    );
}

#[tokio::test]
async fn initial_native_spawn_prepares_the_selected_provider_profile_before_launch() {
    let (root, state, launcher, _) =
        fixture(vec![LaunchOutcome::AdvancedAfterProviderPathExists {
            session_id: "initial-native-session",
            launch_idempotency_key: "initial-native-create-key",
            relative_path: "packages/standalone/current/codex",
        }])
        .await;
    let repository = crate::workspace_git::tests::repository().await;
    let project_root = repository.path().canonicalize().unwrap();
    register_project(
        &state.projects_catalog_path,
        "project-1".into(),
        "Fixture project".into(),
        project_root.to_string_lossy().into_owned(),
    )
    .unwrap();

    let accounts = root.path().join("accounts");
    fs::create_dir(&accounts).unwrap();
    fs::set_permissions(&accounts, fs::Permissions::from_mode(0o700)).unwrap();
    let profile_directory = accounts.join("codex-initial");
    fs::create_dir(&profile_directory).unwrap();
    fs::set_permissions(&profile_directory, fs::Permissions::from_mode(0o700)).unwrap();
    let registered = state
        .credential_profiles
        .register(
            provider_credential_profile::RegisterProviderCredentialProfileBodyV1 {
                schema_version: PROVIDER_CREDENTIAL_PROFILE_SCHEMA_VERSION_V1,
                provider_id: "codex".into(),
                reference_id: "account-initial".into(),
                profile_directory_name: "codex-initial".into(),
            },
        )
        .await
        .unwrap();
    let standalone = root.path().join(".codex/packages/standalone/current");
    fs::create_dir_all(&standalone).unwrap();
    fs::write(standalone.join("codex"), b"fixture codex").unwrap();
    assert!(!profile_directory.join("packages").exists());

    let preview = preview_agent_spawn(
        &state,
        &BackendRequestAuthority {
            backend_id: state.descriptor.backend_id.clone(),
            generation: state.descriptor.generation.clone(),
        },
        &json!({
            "schemaVersion": 1,
            "idempotencyKey": "initial-native-credential-spawn",
            "projectId": "project-1",
            "providerId": "codex",
            "executionProfile": {
                "kind": "credential_reference",
                "reference_id": registered.reference_id,
                "credential_generation": registered.credential_generation,
            },
            "agentName": "credential-initial",
            "worktree": { "kind": "project_root" },
            "promptDigest": null,
            "interactionPreference": "native_cli",
        }),
    )
    .await
    .unwrap();
    let planned: dure_app::AgentSpawnJournalReceiptV1 =
        serde_json::from_value(preview["receipt"].clone()).unwrap();
    let applied = apply_agent_spawn(
        &state,
        &BackendRequestAuthority {
            backend_id: state.descriptor.backend_id.clone(),
            generation: state.descriptor.generation.clone(),
        },
        agent_spawn_apply::AgentSpawnApplyBody {
            schema_version: dure_app::AGENT_SPAWN_SCHEMA_VERSION_V1,
            operation_id: planned.operation_id.clone(),
            plan_token: planned.plan.plan_token.clone(),
            expected_last_sequence: planned.last_sequence,
            prompt: None,
        },
    )
    .await
    .unwrap();

    assert_eq!(applied["receipt"]["state"], "succeeded", "{applied}");
    assert_eq!(launcher.requests().len(), 1);
    assert!(
        profile_directory
            .join("packages/standalone/current/codex")
            .exists()
    );
}

#[tokio::test]
async fn one_dispatch_binds_one_exact_session_and_replay_does_not_launch_again() {
    let (_root, state, launcher, prompt_deliverer, activity_observer) = fixture_with_observation(
        vec![LaunchOutcome::Succeed],
        vec![DeliveryOutcome::Succeed],
        vec![ActivityOutcome::Observed("9")],
    )
    .await;
    let first = receipt(&delegate_once(&state, request()).await.unwrap());
    assert_eq!(first.status, WorkflowDispatchStateV1::Active);
    assert_eq!(
        first.session.as_ref().unwrap().terminal_epoch,
        "worker-terminal"
    );
    assert_eq!(
        first.prompt_delivery.as_ref().unwrap().state,
        WorkflowPromptDeliveryStateV1::WrittenToPty
    );
    assert_eq!(
        first
            .prompt_delivery
            .as_ref()
            .unwrap()
            .evidence
            .as_ref()
            .unwrap()
            .activity()
            .unwrap()
            .state,
        WorkflowPromptActivityStateV1::Observed
    );

    let replay = receipt(&delegate_once(&state, request()).await.unwrap());
    assert_eq!(replay, first);
    let launch_requests = launcher.requests();
    assert_eq!(launch_requests.len(), 1);
    assert_eq!(
        launch_requests[0].permission_mode,
        ProviderPermissionModeV1::Default
    );
    assert_eq!(
        launch_requests[0].provider_arguments,
        crate::provider_extension::test_codex_provider_arguments(ProviderPermissionModeV1::Default,)
    );
    assert_eq!(
        launcher.provider_state_environments(),
        [ProviderStateEnvironment::from_mutations(
            BTreeMap::new(),
            BTreeSet::from(["CODEX_HOME".into(), "CODEX_SQLITE_HOME".into()]),
        )
        .unwrap()],
        "delegate_once must remove inherited credential selectors before launching provider-default Codex",
    );
    assert_eq!(prompt_deliverer.requests().len(), 1);
    let activity_requests = activity_observer.requests();
    assert_eq!(activity_requests.len(), 1);
    assert_eq!(activity_requests[0].input_baseline_output_sequence, "8");
}

#[tokio::test]
async fn bound_prompt_recovery_does_not_reconstruct_launch_only_inputs() {
    let (root, state, _launcher, _prompt_deliverer, _activity_observer) =
        fixture_with_observation(Vec::new(), Vec::new(), Vec::new()).await;
    let request = request();
    let created = state.store.create_delegate_once(&request).await.unwrap();
    let session = WorkflowSessionGenerationV1 {
        session_id: dure_app::workflow_prepared_session_id(&created.dispatch_id).unwrap(),
        workspace_id: "workspace-1".into(),
        provider_id: ProviderIdV1::new("codex").unwrap(),
        runner_principal: "worker-runner".into(),
        runner_instance: "worker-instance".into(),
        channel_epoch: "2".into(),
        host_instance_id: "worker-host".into(),
        terminal_epoch: "worker-terminal".into(),
    };
    let active = state
        .store
        .bind_delegate_once_session(&DelegateOnceSessionBindingRequestV1 {
            schema_version: DELEGATE_ONCE_SCHEMA_VERSION_V1,
            task_id: created.task_id.clone(),
            dispatch_id: created.dispatch_id.clone(),
            generation: created.generation,
            launch_idempotency_key: created.launch_idempotency_key.clone(),
            effective_launch_idempotency_key: created.launch_idempotency_key.clone(),
            session: session.clone(),
            bound_at_ms: 1_100,
        })
        .await
        .unwrap();
    let prompt = active.prompt_delivery.as_ref().unwrap();
    let claimed = state
        .store
        .claim_delegate_once_prompt(&DelegateOncePromptClaimRequestV1 {
            schema_version: DELEGATE_ONCE_SCHEMA_VERSION_V1,
            task_id: active.task_id.clone(),
            dispatch_id: active.dispatch_id.clone(),
            generation: active.generation,
            delivery_idempotency_key: prompt.idempotency_key.clone(),
            session: session.clone(),
            claimed_at_ms: 1_200,
        })
        .await
        .unwrap()
        .receipt;
    let written = state
        .store
        .record_delegate_once_prompt_outcome(&DelegateOncePromptOutcomeRequestV1 {
            schema_version: DELEGATE_ONCE_SCHEMA_VERSION_V1,
            task_id: claimed.task_id.clone(),
            dispatch_id: claimed.dispatch_id.clone(),
            generation: claimed.generation,
            delivery_idempotency_key: prompt.idempotency_key.clone(),
            session,
            outcome: WorkflowPromptDeliveryOutcomeV1::WrittenToPty(
                WorkflowPromptDeliveryEvidenceV1::agent_prompt(
                    "worker-terminal",
                    "41",
                    "8",
                    Some("7".into()),
                ),
            ),
            recorded_at_ms: 1_300,
        })
        .await
        .unwrap();
    assert!(
        written
            .prompt_delivery
            .as_ref()
            .unwrap()
            .evidence
            .as_ref()
            .unwrap()
            .activity()
            .is_none()
    );

    fs::remove_file(root.path().join("codex-fixture")).unwrap();
    let (reopened, launcher, prompt_deliverer, activity_observer) =
        reopen_fixture_service_state_with_prompt_observation(
            &state,
            &state.descriptor.database_path,
        )
        .await;
    let recovered = receipt(&delegate_once(&reopened, request).await.unwrap());

    assert_eq!(recovered.status, WorkflowDispatchStateV1::Active);
    assert_eq!(launcher.requests().len(), 0);
    assert_eq!(prompt_deliverer.requests().len(), 0);
    assert_eq!(activity_observer.requests().len(), 1);
    assert_eq!(
        recovered
            .prompt_delivery
            .as_ref()
            .unwrap()
            .evidence
            .as_ref()
            .unwrap()
            .activity()
            .unwrap()
            .state,
        WorkflowPromptActivityStateV1::Observed
    );
}

#[tokio::test]
async fn one_dispatch_persists_the_advanced_successor_generation() {
    let (_root, state, launcher, _prompt_deliverer, _activity_observer) = fixture_with_observation(
        vec![LaunchOutcome::Advanced {
            session_id: "worker-session-advanced",
            launch_idempotency_key: "worker-create-advanced",
        }],
        vec![DeliveryOutcome::Succeed],
        vec![ActivityOutcome::Observed("9")],
    )
    .await;

    let active = receipt(&delegate_once(&state, request()).await.unwrap());
    assert_eq!(active.status, WorkflowDispatchStateV1::Active);
    let launch_requests = launcher.requests();
    assert_eq!(launch_requests.len(), 1);
    assert_ne!(launch_requests[0].session_id, "worker-session-advanced");
    assert_eq!(
        active.launch_idempotency_key,
        launch_requests[0].launch_idempotency_key
    );
    assert_eq!(
        active.effective_launch_idempotency_key.as_deref(),
        Some("worker-create-advanced")
    );
    assert_eq!(
        active.session,
        Some(WorkflowSessionGenerationV1 {
            session_id: "worker-session-advanced".into(),
            workspace_id: launch_requests[0].workspace_id.clone(),
            provider_id: launch_requests[0].provider_id.clone(),
            runner_principal: "worker-runner".into(),
            runner_instance: "worker-instance".into(),
            channel_epoch: "2".into(),
            host_instance_id: "worker-host".into(),
            terminal_epoch: "worker-terminal".into(),
        })
    );
    let persisted = state
        .store
        .delegate_once_receipt("workflow-control-plane-1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(persisted.session, active.session);
    assert_eq!(
        persisted.launch_idempotency_key,
        active.launch_idempotency_key
    );
    assert_eq!(
        persisted.effective_launch_idempotency_key,
        active.effective_launch_idempotency_key
    );
}

#[tokio::test]
async fn legacy_successor_effective_launch_self_heals_from_the_exact_hmux_receipt() {
    let (_root, state, _launcher, _prompt_deliverer) = fixture(vec![LaunchOutcome::Advanced {
        session_id: "worker-session-advanced",
        launch_idempotency_key: "worker-create-advanced",
    }])
    .await;
    let active = receipt(&delegate_once(&state, request()).await.unwrap());
    let session = active.session.clone().unwrap();
    complete_fixture_managed_create(&state, &session, "worker-create-advanced");
    set_fixture_effective_launch(&state, &active.dispatch_id, None).await;

    let raw = state
        .store
        .delegate_once_receipt_for_dispatch(&active.task_id, &active.dispatch_id, active.generation)
        .await
        .unwrap();
    assert_eq!(raw.effective_launch_idempotency_key, None);
    let repaired = receipt(
        &show_delegate_once(
            &state,
            DelegateOnceShowBody {
                schema_version: DELEGATE_ONCE_SCHEMA_VERSION_V1,
                task_id: active.task_id.clone(),
                dispatch_id: active.dispatch_id.clone(),
                generation: active.generation,
            },
        )
        .await
        .unwrap(),
    );
    assert_eq!(
        repaired.effective_launch_idempotency_key.as_deref(),
        Some("worker-create-advanced")
    );
    assert_eq!(
        repaired.launch_idempotency_key,
        active.launch_idempotency_key
    );
    assert_eq!(repaired.session.as_ref(), Some(&session));
}

#[tokio::test]
async fn legacy_successor_effective_launch_requires_an_exact_hmux_receipt() {
    let (_root, state, _launcher, _prompt_deliverer) = fixture(vec![LaunchOutcome::Advanced {
        session_id: "worker-session-advanced",
        launch_idempotency_key: "worker-create-advanced",
    }])
    .await;
    let active = receipt(&delegate_once(&state, request()).await.unwrap());
    set_fixture_effective_launch(&state, &active.dispatch_id, None).await;

    let error = show_delegate_once(
        &state,
        DelegateOnceShowBody {
            schema_version: DELEGATE_ONCE_SCHEMA_VERSION_V1,
            task_id: active.task_id.clone(),
            dispatch_id: active.dispatch_id.clone(),
            generation: active.generation,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "orchestration_generation_conflict");
    let raw = state
        .store
        .delegate_once_receipt_for_dispatch(&active.task_id, &active.dispatch_id, active.generation)
        .await
        .unwrap();
    assert_eq!(raw.effective_launch_idempotency_key, None);
}

#[tokio::test]
async fn legacy_successor_effective_launch_rejects_a_prepared_root_key_before_writing() {
    let (_root, state, _launcher, _prompt_deliverer) = fixture(vec![LaunchOutcome::Advanced {
        session_id: "worker-session-advanced",
        launch_idempotency_key: "worker-create-advanced",
    }])
    .await;
    let active = receipt(&delegate_once(&state, request()).await.unwrap());
    let session = active.session.clone().unwrap();
    complete_fixture_managed_create(&state, &session, &active.launch_idempotency_key);
    set_fixture_effective_launch(&state, &active.dispatch_id, None).await;

    let error = show_delegate_once(
        &state,
        DelegateOnceShowBody {
            schema_version: DELEGATE_ONCE_SCHEMA_VERSION_V1,
            task_id: active.task_id.clone(),
            dispatch_id: active.dispatch_id.clone(),
            generation: active.generation,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "workflow_request_invalid");
    let raw = state
        .store
        .delegate_once_receipt_for_dispatch(&active.task_id, &active.dispatch_id, active.generation)
        .await
        .unwrap();
    assert_eq!(raw.effective_launch_idempotency_key, None);
}

#[tokio::test]
async fn explicit_source_permission_overrides_provider_default_and_replays_once() {
    let (_root, state, launcher, _prompt_deliverer, _activity_observer) =
        fixture_with_source_authority(
            vec![LaunchOutcome::Succeed],
            vec![DeliveryOutcome::Succeed],
            vec![ActivityOutcome::Observed("9")],
            HmuxPermissionMode::BypassApprovals,
            "coordinator-terminal",
        )
        .await;
    state
        .store
        .put_provider_launch_defaults(
            &ProviderLaunchDefaultsPutRequestV1 {
                schema_version: PROVIDER_LAUNCH_DEFAULTS_SCHEMA_VERSION_V1,
                idempotency_key: "workflow-provider-defaults-1".into(),
                expected_revision: 0,
                defaults: BTreeMap::from([(
                    ProviderIdV1::new("codex").unwrap(),
                    ProviderLaunchDefaultV1 {
                        permission_mode: ProviderLaunchPermissionModeV1::RequireApprovals,
                    },
                )]),
            },
            999,
        )
        .await
        .unwrap();

    let first = receipt(&delegate_once(&state, request()).await.unwrap());
    assert_eq!(first.status, WorkflowDispatchStateV1::Active);
    assert_eq!(
        receipt(&delegate_once(&state, request()).await.unwrap()),
        first
    );

    let requests = launcher.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].permission_mode,
        ProviderPermissionModeV1::SkipPermissions
    );
    assert_eq!(
        requests[0].provider_arguments,
        crate::provider_extension::test_codex_provider_arguments(
            ProviderPermissionModeV1::SkipPermissions,
        )
    );
}

#[tokio::test]
async fn source_permission_generation_mismatch_fails_before_launch_or_persistence() {
    let (_root, state, launcher, _prompt_deliverer, _activity_observer) =
        fixture_with_source_authority(
            vec![LaunchOutcome::Succeed],
            vec![DeliveryOutcome::Succeed],
            vec![ActivityOutcome::Observed("9")],
            HmuxPermissionMode::BypassApprovals,
            "replacement-terminal",
        )
        .await;

    let error = delegate_once(&state, request()).await.unwrap_err();
    assert_eq!(error.code, "workflow_coordinator_permission_mismatch");
    assert!(
        state
            .store
            .delegate_once_receipt("workflow-control-plane-1")
            .await
            .unwrap()
            .is_none()
    );
    assert!(launcher.requests().is_empty());
}

#[tokio::test]
async fn workflow_show_reads_only_the_exact_active_receipt() {
    let (_root, state, _launcher, _prompt_deliverer) = fixture(vec![LaunchOutcome::Succeed]).await;
    let active = receipt(&delegate_once(&state, request()).await.unwrap());
    let body = DelegateOnceShowBody {
        schema_version: DELEGATE_ONCE_SCHEMA_VERSION_V1,
        task_id: active.task_id.clone(),
        dispatch_id: active.dispatch_id.clone(),
        generation: active.generation,
    };
    let backend_request = BackendRequest {
        schema_version: 1,
        api_version: BACKEND_PROTOCOL_API.into(),
        kind: BACKEND_REQUEST_KIND.into(),
        request_id: "workflow-show-1".into(),
        operation: "workflow.delegate_once.show".into(),
        expected: ExpectedBackend {
            scope_id: None,
            backend_id: BACKEND_ID.into(),
            generation: state.descriptor.generation.clone(),
            protocol: ExpectedProtocol {
                minimum: ProtocolVersion { major: 1, minor: 0 },
                maximum: ProtocolVersion { major: 1, minor: 0 },
            },
            required_capabilities: vec!["workflow.delegate_once.show".into()],
        },
        body: serde_json::to_value(&body).unwrap(),
        connection: None,
    };
    assert_eq!(
        receipt(&dispatch(&state, &backend_request).await.unwrap()),
        active
    );
    assert_eq!(
        receipt(&dispatch(&state, &backend_request).await.unwrap()),
        active
    );

    let error = show_delegate_once(
        &state,
        DelegateOnceShowBody {
            generation: active.generation + 1,
            ..body
        },
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "workflow_identity_conflict");
}

#[tokio::test]
async fn worker_done_requires_the_exact_session_and_replays_one_completion() {
    let (_root, state, _launcher, _prompt_deliverer) = fixture(vec![LaunchOutcome::Succeed]).await;
    let active = receipt(&delegate_once(&state, request()).await.unwrap());
    bind_fixture_worker_context(&state, &active).await;
    let mut body = DelegateOnceCompleteBody {
        schema_version: DELEGATE_ONCE_SCHEMA_VERSION_V1,
        task_id: active.task_id.clone(),
        dispatch_id: active.dispatch_id.clone(),
        generation: active.generation,
        session: active.session.clone().unwrap(),
        result: Some("Implemented the requested change.".into()),
    };
    body.session.terminal_epoch = "replacement-terminal".into();
    let error = complete_delegate_once(&state, body).await.unwrap_err();
    assert_eq!(error.code, "orchestration_generation_conflict");

    let body = DelegateOnceCompleteBody {
        schema_version: DELEGATE_ONCE_SCHEMA_VERSION_V1,
        task_id: active.task_id,
        dispatch_id: active.dispatch_id,
        generation: active.generation,
        session: active.session.unwrap(),
        result: Some("Implemented the requested change.".into()),
    };
    let backend_request = BackendRequest {
        schema_version: 1,
        api_version: BACKEND_PROTOCOL_API.into(),
        kind: BACKEND_REQUEST_KIND.into(),
        request_id: "worker-done-1".into(),
        operation: "workflow.delegate_once.complete".into(),
        expected: ExpectedBackend {
            scope_id: None,
            backend_id: BACKEND_ID.into(),
            generation: state.descriptor.generation.clone(),
            protocol: ExpectedProtocol {
                minimum: ProtocolVersion { major: 1, minor: 0 },
                maximum: ProtocolVersion { major: 1, minor: 0 },
            },
            required_capabilities: vec!["workflow.delegate_once.complete".into()],
        },
        body: serde_json::to_value(body).unwrap(),
        connection: None,
    };
    let completed = receipt(&dispatch(&state, &backend_request).await.unwrap());
    assert_eq!(completed.status, WorkflowDispatchStateV1::Completed);
    assert_eq!(
        completed.result.as_deref(),
        Some("Implemented the requested change.")
    );
    assert_eq!(
        receipt(&dispatch(&state, &backend_request).await.unwrap()),
        completed
    );
    let mut conflicting_request = backend_request.clone();
    conflicting_request.request_id = "worker-done-conflict".into();
    conflicting_request.body["result"] = serde_json::json!("A different result.");
    assert_eq!(
        dispatch(&state, &conflicting_request)
            .await
            .unwrap_err()
            .code,
        "orchestration_idempotency_conflict"
    );
    assert_eq!(
        receipt(
            &show_delegate_once(
                &state,
                DelegateOnceShowBody {
                    schema_version: DELEGATE_ONCE_SCHEMA_VERSION_V1,
                    task_id: completed.task_id.clone(),
                    dispatch_id: completed.dispatch_id.clone(),
                    generation: completed.generation,
                },
            )
            .await
            .unwrap()
        ),
        completed
    );
}

#[tokio::test]
async fn dispatch_context_batch_resolves_the_same_exact_context() {
    let (_root, state, _launcher, _prompt_deliverer) = fixture(vec![LaunchOutcome::Succeed]).await;
    let active = receipt(&delegate_once(&state, request()).await.unwrap());
    bind_fixture_worker_context(&state, &active).await;
    let session = active.session.clone().unwrap();
    let unassigned = WorkflowSessionGenerationV1 {
        session_id: "coordinator-session".into(),
        workspace_id: "coordinator-workspace".into(),
        provider_id: ProviderIdV1::new("codex").unwrap(),
        runner_principal: "coordinator-runner".into(),
        runner_instance: "coordinator-instance".into(),
        channel_epoch: "1".into(),
        host_instance_id: "coordinator-host".into(),
        terminal_epoch: "coordinator-terminal".into(),
    };
    let mut stale = unassigned.clone();
    stale.terminal_epoch = "coordinator-terminal-stale".into();

    let scalar = invoke_orchestration(
        &state,
        "dispatch-context-scalar",
        "dispatch.context.get",
        json!({ "schemaVersion": 1, "session": session }),
    )
    .await;
    let batch = invoke_orchestration(
        &state,
        "dispatch-context-batch",
        "dispatch.context.get.batch",
        json!({ "schemaVersion": 1, "sessions": [session, unassigned, stale] }),
    )
    .await;

    assert_eq!(batch["receipt"]["schemaVersion"], 1);
    assert_eq!(batch["receipt"]["results"][0]["outcome"], "found");
    assert_eq!(
        batch["receipt"]["results"][0]["session"],
        serde_json::to_value(&session).unwrap()
    );
    assert_eq!(batch["receipt"]["results"][0]["context"], scalar["receipt"]);
    assert_eq!(batch["receipt"]["results"][1]["outcome"], "failed");
    assert_eq!(
        batch["receipt"]["results"][1]["error"]["details"]["disposition"],
        "unassigned"
    );
    assert_eq!(batch["receipt"]["results"][2]["outcome"], "failed");
    assert_eq!(
        batch["receipt"]["results"][2]["error"]["details"]["disposition"],
        "stale_generation"
    );
}

#[tokio::test]
async fn closed_reporting_agent_candidate_is_terminal_without_mutating_dispatch() {
    for (label, advance, expected_code, expected_disposition) in [
        (
            "stopped",
            Some(AgentRuntimeCloseAdvanceV1::Stopped),
            "orchestration_reporting_unavailable",
            "terminal",
        ),
        (
            "admitted",
            None,
            "orchestration_reporting_unavailable",
            "terminal",
        ),
        (
            "source-retained",
            Some(AgentRuntimeCloseAdvanceV1::SourceRetained),
            "orchestration_generation_conflict",
            "unassigned",
        ),
    ] {
        let agent_id = AgentIdV1::new(format!("closed-reporting-agent-{label}")).unwrap();
        let (root, state, launcher, prompt_deliverer, _) = fixture_with_source_launch_authority(
            Vec::new(),
            vec![DeliveryOutcome::Succeed],
            vec![ActivityOutcome::Observed("9")],
            HmuxPermissionMode::Default,
            "coordinator-terminal",
            SourceLaunchAuthorityFixture {
                agent_id: agent_id.clone(),
                agent_provider_id: ProviderIdV1::new("codex").unwrap(),
                ..SourceLaunchAuthorityFixture::default()
            },
        )
        .await;
        let source = AgentRuntimeSelectionV1 {
            schema_version: 1,
            agent_id: agent_id.clone(),
            provider_id: ProviderIdV1::new("codex").unwrap(),
            interaction_profile: AgentInteractionProfileV1::NativeCli,
            execution_profile: AgentExecutionProfileV1::ProviderDefault,
            permission_mode: ProviderPermissionModeV1::Default,
            model: None,
            effort: None,
            revision: 1,
            selected_by_operation_id: None,
            updated_at_ms: 2,
        };
        state
            .store
            .initialize_agent_runtime_selection(&source)
            .await
            .unwrap();
        let created = invoke_orchestration(
            &state,
            &format!("closed-reporting-run-{label}"),
            "run.create",
            existing_session_run_body(),
        )
        .await;
        let old_session: WorkflowSessionGenerationV1 =
            serde_json::from_value(existing_session_run_body()["session"].clone()).unwrap();
        let old_context = created["receipt"]["context"].clone();
        let expected_dispatch = json!({
            "taskId": old_context["target"]["taskId"],
            "dispatchId": old_context["target"]["dispatchId"],
            "generation": old_context["target"]["generation"],
        });
        let source_authority = state
            .store
            .agent_checkpoint_binding_authority(&agent_id)
            .await
            .unwrap()
            .unwrap();
        let close_operation_id =
            OperationIdV1::new(format!("closed-reporting-close-{label}")).unwrap();
        let admitted = state
            .store
            .admit_agent_runtime_close(&AgentRuntimeCloseIntentV1 {
                schema_version: AGENT_RUNTIME_CLOSE_SCHEMA_VERSION_V1,
                operation_id: close_operation_id.clone(),
                idempotency_key: format!("closed-reporting-close-key-{label}"),
                requested_at_ms: 1_100,
                source,
                source_authority: AgentRuntimeBindingAuthorityV1::NativeCli {
                    authority: source_authority,
                },
                stopped_transition: None,
            })
            .await
            .unwrap();
        let expected_close = match advance {
            Some(advance) => state
                .store
                .advance_agent_runtime_close(&AgentRuntimeCloseAdvanceRequestV1 {
                    schema_version: AGENT_RUNTIME_CLOSE_SCHEMA_VERSION_V1,
                    operation_id: close_operation_id.clone(),
                    expected_journal_revision: admitted.journal_revision,
                    advance,
                    advanced_at_ms: 1_101,
                })
                .await
                .unwrap(),
            None => admitted,
        };
        let fresh_session = WorkflowSessionGenerationV1 {
            session_id: format!("fresh-session-{label}"),
            workspace_id: "coordinator-workspace".into(),
            provider_id: ProviderIdV1::new("codex").unwrap(),
            runner_principal: "fresh-runner".into(),
            runner_instance: format!("fresh-instance-{label}"),
            channel_epoch: "2".into(),
            host_instance_id: format!("fresh-host-{label}"),
            terminal_epoch: format!("fresh-terminal-{label}"),
        };
        fs::write(
            state
                .hmux_identity
                .discovery_root
                .join("current-session.json"),
            serde_json::to_vec(&json!({
                "schema_version": 1,
                "session_id": fresh_session.session_id,
                "workspace_id": fresh_session.workspace_id,
                "session_class": "managed",
                "lifecycle": "ready",
                "provider_id": fresh_session.provider_id,
                "runner_principal": fresh_session.runner_principal,
                "runner_instance": fresh_session.runner_instance,
                "channel_epoch": fresh_session.channel_epoch,
                "host_instance_id": fresh_session.host_instance_id,
                "terminal_epoch": fresh_session.terminal_epoch,
                "health": "healthy",
            }))
            .unwrap(),
        )
        .unwrap();
        complete_fixture_managed_create(&state, &fresh_session, &format!("fresh-create-{label}"));
        let candidates = json!([
            {
                "agentId": agent_id,
                "session": old_session,
                "expectedDispatch": expected_dispatch,
            },
            {
                "agentId": agent_id,
                "session": fresh_session,
                "expectedDispatch": expected_dispatch,
            }
        ]);

        for attempt in 0..2 {
            let batch = invoke_orchestration(
                &state,
                &format!("closed-reporting-context-{label}-{attempt}"),
                "dispatch.context.get.batch",
                json!({ "schemaVersion": 1, "candidates": candidates }),
            )
            .await;
            assert_eq!(batch["receipt"]["results"][0]["outcome"], "found");
            assert_eq!(batch["receipt"]["results"][0]["context"], old_context);
            assert_eq!(batch["receipt"]["results"][1]["candidate"], candidates[1]);
            assert_eq!(
                batch["receipt"]["results"][1]["error"]["code"], expected_code,
                "unexpected candidate error for {label}"
            );
            assert_eq!(
                batch["receipt"]["results"][1]["error"]["details"]["disposition"],
                expected_disposition,
                "unexpected candidate disposition for {label}"
            );
        }

        let legacy = invoke_orchestration(
            &state,
            &format!("closed-reporting-legacy-{label}"),
            "dispatch.context.get.batch",
            json!({ "schemaVersion": 1, "sessions": [fresh_session] }),
        )
        .await;
        assert_eq!(
            legacy["receipt"]["results"][0]["error"]["details"]["disposition"],
            "unassigned"
        );
        if label == "stopped" {
            let uncorrelated = invoke_orchestration(
                &state,
                "closed-reporting-without-dispatch",
                "dispatch.context.get.batch",
                json!({
                    "schemaVersion": 1,
                    "candidates": [{
                        "agentId": agent_id,
                        "session": fresh_session,
                    }]
                }),
            )
            .await;
            assert_eq!(
                uncorrelated["receipt"]["results"][0]["error"]["details"]["disposition"],
                "unassigned"
            );
            let mismatched = invoke_orchestration(
                &state,
                "closed-reporting-wrong-agent",
                "dispatch.context.get.batch",
                json!({
                    "schemaVersion": 1,
                    "candidates": [{
                        "agentId": "different-agent",
                        "session": fresh_session,
                        "expectedDispatch": expected_dispatch,
                    }]
                }),
            )
            .await;
            assert_eq!(
                mismatched["receipt"]["results"][0]["error"]["code"],
                "orchestration_request_invalid"
            );
            assert_eq!(
                mismatched["receipt"]["results"][0]["error"]["details"]["disposition"],
                "terminal"
            );
        }
        assert_eq!(
            state
                .store
                .agent_runtime_close(&close_operation_id)
                .await
                .unwrap(),
            Some(expected_close)
        );
        assert_eq!(
            state
                .store
                .active_agent_runtime_transition(&agent_id)
                .await
                .unwrap(),
            None
        );
        assert!(launcher.requests().is_empty());
        assert!(prompt_deliverer.requests().is_empty());
        let pool = sqlx::SqlitePool::connect_with(
            sqlx::sqlite::SqliteConnectOptions::new()
                .filename(root.path().join("domain.sqlite"))
                .read_only(true),
        )
        .await
        .unwrap();
        let run_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM workflow_runs WHERE contribution_id = 'workflow.existing-session-reporting'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(run_count, 1);
        pool.close().await;
    }
}

#[tokio::test]
async fn dispatch_context_batch_rejects_invalid_bounds_and_duplicates() {
    let (_root, state, _launcher, _prompt_deliverer) = fixture(vec![LaunchOutcome::Succeed]).await;
    let active = receipt(&delegate_once(&state, request()).await.unwrap());
    let session = active.session.clone().unwrap();
    let invalid_requests = vec![
        json!({ "schemaVersion": 1, "sessions": [] }),
        json!({ "schemaVersion": 1, "sessions": [session, session] }),
        json!({ "schemaVersion": 1, "candidates": [] }),
        json!({
            "schemaVersion": 1,
            "candidates": [{
                "agentId": "agent-1",
                "session": session,
                "expectedDispatch": {
                    "taskId": "task-1",
                    "dispatchId": "dispatch-1",
                    "generation": 0
                }
            }]
        }),
        json!({
            "schemaVersion": 1,
            "sessions": [session],
            "candidates": [{ "agentId": "agent-1", "session": session }]
        }),
        json!({
            "schemaVersion": 1,
            "candidates": [
                { "agentId": "agent-1", "session": session },
                { "agentId": "agent-1", "session": session }
            ]
        }),
        json!({
            "schemaVersion": 1,
            "sessions": (0..33)
                .map(|index| WorkflowSessionGenerationV1 {
                    session_id: format!("session-{index}"),
                    workspace_id: format!("workspace-{index}"),
                    provider_id: session.provider_id.clone(),
                    runner_principal: "runner".into(),
                    runner_instance: format!("instance-{index}"),
                    channel_epoch: "1".into(),
                    host_instance_id: format!("host-{index}"),
                    terminal_epoch: format!("terminal-{index}"),
                })
                .collect::<Vec<_>>()
        }),
        json!({
            "schemaVersion": 1,
            "candidates": (0..33)
                .map(|index| json!({
                    "agentId": format!("agent-{index}"),
                    "session": WorkflowSessionGenerationV1 {
                        session_id: format!("candidate-session-{index}"),
                        workspace_id: format!("candidate-workspace-{index}"),
                        provider_id: session.provider_id.clone(),
                        runner_principal: "runner".into(),
                        runner_instance: format!("candidate-instance-{index}"),
                        channel_epoch: "1".into(),
                        host_instance_id: format!("candidate-host-{index}"),
                        terminal_epoch: format!("candidate-terminal-{index}"),
                    }
                }))
                .collect::<Vec<_>>()
        }),
    ];

    for (index, body) in invalid_requests.into_iter().enumerate() {
        let error = dispatch(
            &state,
            &orchestration_backend_request(
                &state,
                &format!("dispatch-context-invalid-{index}"),
                "dispatch.context.get.batch",
                body,
            ),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "orchestration_request_invalid");
        assert_eq!(error.disposition, BackendFailureDispositionV1::Terminal);
    }
}

#[tokio::test]
async fn event_read_batch_matches_the_scalar_receipt() {
    let (_root, state, _launcher, _prompt_deliverer) = fixture(Vec::new()).await;
    let (context, _session) = prepare_exact_session_run(&state).await;
    let target = context["target"].clone();
    let read_body = json!({
        "schemaVersion": 1,
        "authority": target["authority"],
        "target": target,
        "participant": context["coordinatorGrant"]["participant"],
        "deliveryCapability": context["coordinatorGrant"]["deliveryCapability"],
        "after": 0,
        "limit": 128
    });
    let mut denied_body = json!({
        "schemaVersion": 1,
        "authority": target["authority"],
        "target": target,
        "participant": context["participant"],
        "deliveryCapability": context["deliveryCapability"],
        "endpointFence": context["endpointFence"],
        "after": 0,
        "limit": 128
    });
    denied_body["deliveryCapability"] = json!("capability-wrong");
    denied_body["endpointFence"]["deliveryCapability"] = json!("capability-wrong");
    let batch = invoke_orchestration(
        &state,
        "event-read-batch",
        "events.read.batch",
        json!({
            "schemaVersion": 1,
            "authority": context["target"]["authority"],
            "requests": [
                {
                    "correlationId": "subscription-1",
                    "request": read_body
                },
                {
                    "correlationId": "subscription-denied",
                    "request": denied_body
                },
                {
                    "correlationId": "subscription-2",
                    "request": read_body
                }
            ]
        }),
    )
    .await;
    let scalar = invoke_orchestration(
        &state,
        "event-read-scalar",
        "events.read",
        read_body.clone(),
    )
    .await;

    assert_eq!(batch["receipt"]["schemaVersion"], 1);
    assert_eq!(batch["receipt"]["results"][0]["outcome"], "read");
    assert_eq!(
        batch["receipt"]["results"][0]["correlationId"],
        "subscription-1"
    );
    assert_eq!(
        batch["receipt"]["results"][0]["receipt"]["deliveries"][0]["state"],
        "observed"
    );
    assert_eq!(batch["receipt"]["results"][1]["outcome"], "failed");
    assert_eq!(
        batch["receipt"]["results"][1]["error"]["code"],
        "orchestration_capability_denied"
    );
    assert_eq!(batch["receipt"]["results"][2]["outcome"], "read");
    assert_eq!(
        batch["receipt"]["results"][2]["receipt"],
        batch["receipt"]["results"][0]["receipt"]
    );
    assert_eq!(batch["receipt"]["results"][0]["receipt"], scalar["receipt"]);
}

#[tokio::test]
async fn event_read_batch_rejects_invalid_bounds_and_correlations_as_terminal() {
    let (_root, state, _launcher, _prompt_deliverer) = fixture(Vec::new()).await;
    let (context, _session) = prepare_exact_session_run(&state).await;
    let item = json!({
        "correlationId": "subscription-1",
        "request": {
            "schemaVersion": 1,
            "authority": context["target"]["authority"],
            "target": context["target"],
            "participant": context["coordinatorGrant"]["participant"],
            "deliveryCapability": context["coordinatorGrant"]["deliveryCapability"],
            "after": 0,
            "limit": 128
        }
    });
    let invalid_requests = vec![
        Vec::new(),
        vec![item.clone(), item.clone()],
        vec![json!({
            "correlationId": "subscription/invalid",
            "request": item["request"].clone()
        })],
        (0..33)
            .map(|index| {
                json!({
                    "correlationId": format!("subscription-{index}"),
                    "request": item["request"].clone()
                })
            })
            .collect(),
    ];

    for (index, requests) in invalid_requests.into_iter().enumerate() {
        let error = dispatch(
            &state,
            &orchestration_backend_request(
                &state,
                &format!("event-read-batch-invalid-{index}"),
                "events.read.batch",
                json!({
                    "schemaVersion": 1,
                    "authority": context["target"]["authority"],
                    "requests": requests
                }),
            ),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "orchestration_request_invalid");
        assert_eq!(error.disposition, BackendFailureDispositionV1::Terminal);
    }
}

#[tokio::test]
async fn event_read_route_batch_preserves_order_and_isolates_authority_failures() {
    let (root, state, _launcher, _prompt_deliverer) = fixture(Vec::new()).await;
    let mut contexts = Vec::new();
    for index in 0..3 {
        let workspace_id = WorkspaceIdV1::new(format!("route-workspace-{index}")).unwrap();
        let agent_id = AgentIdV1::new(format!("route-agent-{index}")).unwrap();
        let session_id = format!("route-session-{index}");
        let runtime_workspace_id = format!("route-runtime-workspace-{index}");
        let runner_instance = format!("route-instance-{index}");
        let host_instance_id = format!("route-host-{index}");
        let terminal_epoch = format!("route-terminal-{index}");
        state
            .store
            .upsert_workspace(&WorkspaceRecordV1 {
                workspace_id: workspace_id.clone(),
                project_id: ProjectIdV1::new("project-1").unwrap(),
                root_path: root
                    .path()
                    .join(format!("route-workspace-{index}"))
                    .to_string_lossy()
                    .into_owned(),
                base_commit_sha: None,
                created_at_ms: 1,
                updated_at_ms: 1,
            })
            .await
            .unwrap();
        state
            .store
            .upsert_agent(&AgentRecordV1 {
                agent_id: agent_id.clone(),
                workspace_id: workspace_id.clone(),
                provider_id: ProviderIdV1::new("codex").unwrap(),
                display_name: format!("Route agent {index}"),
                created_at_ms: 1,
                updated_at_ms: 1,
            })
            .await
            .unwrap();
        state
            .store
            .upsert_agent_checkpoint_binding_authority(&AgentCheckpointBindingAuthorityV1 {
                schema_version: AGENT_CHECKPOINT_SCHEMA_VERSION_V1,
                binding: SessionBindingRecordV1 {
                    agent_id,
                    runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
                    session_id: session_id.clone(),
                    provider_conversation_id: None,
                    credential_reference_id: None,
                    binding_generation: 1,
                    bound_at_ms: 1,
                },
                runtime_workspace_id: runtime_workspace_id.clone(),
                runner_principal: "route-runner".into(),
                runner_instance: runner_instance.clone(),
                channel_epoch: "1".into(),
                host_instance_id: host_instance_id.clone(),
                terminal_epoch: terminal_epoch.clone(),
                updated_at_ms: 1,
            })
            .await
            .unwrap();
        let body = existing_session_run_body();
        let request: CreateRunRequest = serde_json::from_value(json!({
            "schemaVersion": 1,
            "authority": { "workspaceId": workspace_id.as_str() },
            "workflowKindRef": body["workflowKindRef"],
            "task": body["task"],
            "session": {
                "sessionId": session_id,
                "workspaceId": runtime_workspace_id,
                "providerId": "codex",
                "runnerPrincipal": "route-runner",
                "runnerInstance": runner_instance,
                "channelEpoch": "1",
                "hostInstanceId": host_instance_id,
                "terminalEpoch": terminal_epoch
            },
            "integrationReceipt": body["integrationReceipt"],
            "runtimeRef": body["runtimeRef"],
            "targetReference": body["targetReference"],
            "idempotencyKey": format!("route-batch-run-{index}"),
            "createdAtMs": 1_100 + index
        }))
        .unwrap();
        let target = create_run_target(&request).unwrap();
        let proposal = orchestration_context_proposal(
            &target,
            worker_session_identity(&request.session).unwrap(),
            &request.integration_receipt,
        )
        .unwrap();
        let created = state
            .store
            .interaction_service()
            .create_run(request, proposal)
            .await
            .unwrap();
        contexts.push(serde_json::to_value(created.context).unwrap());
    }

    let fault_pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(root.path().join("domain.sqlite")),
    )
    .await
    .unwrap();
    let failed_dispatch = contexts[1]["target"]["dispatchId"].as_str().unwrap();
    sqlx::query(&format!(
        r#"
        CREATE TRIGGER fail_middle_route_batch_authority
        BEFORE UPDATE ON workflow_interaction_authorities
        WHEN OLD.dispatch_id = '{failed_dispatch}'
        BEGIN
            SELECT RAISE(ABORT, 'fault-injected routed Event batch authority write');
        END
        "#,
    ))
    .execute(&fault_pool)
    .await
    .unwrap();

    let mut batches = contexts
        .iter()
        .enumerate()
        .map(|(index, context)| {
            json!({
                "correlationId": format!("authority-{index}"),
                "request": {
                    "schemaVersion": 1,
                    "authority": context["target"]["authority"],
                    "requests": [{
                        "correlationId": format!("subscription-{index}"),
                        "request": {
                            "schemaVersion": 1,
                            "authority": context["target"]["authority"],
                            "target": context["target"],
                            "participant": context["coordinatorGrant"]["participant"],
                            "deliveryCapability": context["coordinatorGrant"]["deliveryCapability"],
                            "after": 0,
                            "limit": 10
                        }
                    }]
                }
            })
        })
        .collect::<Vec<_>>();
    let routed = invoke_orchestration(
        &state,
        "event-read-route-batch",
        "events.read.route.batch",
        json!({ "schemaVersion": 1, "batches": batches.clone() }),
    )
    .await;

    assert_eq!(routed["receipt"]["schemaVersion"], 1);
    assert_eq!(routed["receipt"]["results"][0]["outcome"], "read");
    assert_eq!(
        routed["receipt"]["results"][0]["correlationId"],
        "authority-0"
    );
    assert_eq!(
        routed["receipt"]["results"][0]["receipt"]["results"][0]["outcome"],
        "read"
    );
    assert_eq!(routed["receipt"]["results"][1]["outcome"], "failed");
    assert_eq!(
        routed["receipt"]["results"][1]["correlationId"],
        "authority-1"
    );
    assert_eq!(
        routed["receipt"]["results"][1]["authority"],
        contexts[1]["target"]["authority"]
    );
    assert_eq!(
        routed["receipt"]["results"][1]["error"]["code"],
        "orchestration_store_unavailable"
    );
    assert_eq!(routed["receipt"]["results"][2]["outcome"], "read");
    assert_eq!(
        routed["receipt"]["results"][2]["correlationId"],
        "authority-2"
    );
    assert_eq!(
        routed["receipt"]["results"][2]["receipt"]["results"][0]["outcome"],
        "read"
    );
    for (context, expected_state) in contexts.iter().zip(["observed", "queued", "observed"]) {
        let delivery_json: String = sqlx::query_scalar(
            r#"
            SELECT delivery.delivery_json
            FROM workflow_interaction_deliveries AS delivery
            JOIN workflow_interaction_authorities AS authority
              ON authority.authority_key = delivery.authority_key
            WHERE authority.dispatch_id = ?1
              AND delivery.event_cursor = 1
              AND json_extract(delivery.delivery_json, '$.receipt.participant') = ?2
            "#,
        )
        .bind(context["target"]["dispatchId"].as_str().unwrap())
        .bind(context["coordinatorGrant"]["participant"].as_str().unwrap())
        .fetch_one(&fault_pool)
        .await
        .unwrap();
        let delivery: Value = serde_json::from_str(&delivery_json).unwrap();
        assert_eq!(delivery["receipt"]["state"], expected_state);
    }

    sqlx::query("DROP TRIGGER fail_middle_route_batch_authority")
        .execute(&fault_pool)
        .await
        .unwrap();
    fault_pool.close().await;

    batches[1]["request"]["schemaVersion"] = json!(2);
    let invalid_nested = invoke_orchestration(
        &state,
        "event-read-route-batch-invalid-nested",
        "events.read.route.batch",
        json!({ "schemaVersion": 1, "batches": batches }),
    )
    .await;
    assert_eq!(invalid_nested["receipt"]["results"][0]["outcome"], "read");
    assert_eq!(invalid_nested["receipt"]["results"][1]["outcome"], "failed");
    assert_eq!(
        invalid_nested["receipt"]["results"][1]["error"]["code"],
        "orchestration_request_invalid"
    );
    assert_eq!(
        invalid_nested["receipt"]["results"][1]["error"]["details"]["disposition"],
        "terminal"
    );
    assert_eq!(invalid_nested["receipt"]["results"][2]["outcome"], "read");
}

#[tokio::test]
async fn event_read_route_batch_rejects_the_whole_envelope_before_service_calls() {
    let (root, state, _launcher, _prompt_deliverer) = fixture(Vec::new()).await;
    let (context, _session) = prepare_exact_session_run(&state).await;
    let item = json!({
        "correlationId": "subscription-valid",
        "request": {
            "schemaVersion": 1,
            "authority": context["target"]["authority"],
            "target": context["target"],
            "participant": context["coordinatorGrant"]["participant"],
            "deliveryCapability": context["coordinatorGrant"]["deliveryCapability"],
            "after": 0,
            "limit": 10
        }
    });
    let valid_batch = json!({
        "correlationId": "authority-valid",
        "request": {
            "schemaVersion": 1,
            "authority": context["target"]["authority"],
            "requests": [item]
        }
    });
    let mut invalid_later_batch = valid_batch.clone();
    invalid_later_batch["correlationId"] = json!("authority-malformed-later");
    let error = dispatch(
        &state,
        &orchestration_backend_request(
            &state,
            "event-read-route-batch-invalid-later",
            "events.read.route.batch",
            json!({
                "schemaVersion": 1,
                "batches": [valid_batch, invalid_later_batch]
            }),
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "orchestration_request_invalid");
    assert_eq!(error.disposition, BackendFailureDispositionV1::Terminal);

    let fault_pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(root.path().join("domain.sqlite")),
    )
    .await
    .unwrap();
    let authority_key: String = sqlx::query_scalar(
        "SELECT authority_key FROM workflow_interaction_authorities WHERE dispatch_id = ?1",
    )
    .bind(context["target"]["dispatchId"].as_str().unwrap())
    .fetch_one(&fault_pool)
    .await
    .unwrap();
    let delivery_json: String = sqlx::query_scalar(
        "SELECT delivery_json FROM workflow_interaction_deliveries WHERE authority_key = ?1 AND event_cursor = 1",
    )
    .bind(authority_key)
    .fetch_one(&fault_pool)
    .await
    .unwrap();
    let delivery: Value = serde_json::from_str(&delivery_json).unwrap();
    assert_eq!(delivery["receipt"]["state"], "queued");
    fault_pool.close().await;
}

#[tokio::test]
async fn dispatch_context_batch_isolates_an_invalid_session_item() {
    let (_root, state, _launcher, _prompt_deliverer) = fixture(vec![LaunchOutcome::Succeed]).await;
    let active = receipt(&delegate_once(&state, request()).await.unwrap());
    bind_fixture_worker_context(&state, &active).await;
    let session = active.session.clone().unwrap();
    let mut invalid_session = session.clone();
    invalid_session.session_id.clear();

    let batch = invoke_orchestration(
        &state,
        "dispatch-context-invalid-item",
        "dispatch.context.get.batch",
        json!({ "schemaVersion": 1, "sessions": [invalid_session, session] }),
    )
    .await;

    assert_eq!(batch["receipt"]["results"][0]["outcome"], "failed");
    assert_eq!(
        batch["receipt"]["results"][0]["error"]["details"]["disposition"],
        "terminal"
    );
    assert_eq!(batch["receipt"]["results"][1]["outcome"], "found");
    assert_eq!(
        batch["receipt"]["results"][1]["session"],
        serde_json::to_value(&session).unwrap()
    );
}

#[tokio::test]
async fn active_dispatch_rebinds_to_one_rehost_successor_and_replays() {
    let (_root, state, _launcher, _prompt_deliverer) = fixture(vec![LaunchOutcome::Succeed]).await;
    let active = receipt(&delegate_once(&state, request()).await.unwrap());
    bind_fixture_worker_context(&state, &active).await;
    let source = active.session.clone().unwrap();
    let target = WorkflowSessionGenerationV1 {
        session_id: "worker-session-rehosted".into(),
        workspace_id: source.workspace_id.clone(),
        provider_id: source.provider_id.clone(),
        runner_principal: source.runner_principal.clone(),
        runner_instance: "worker-instance-rehosted".into(),
        channel_epoch: "3".into(),
        host_instance_id: "worker-host-rehosted".into(),
        terminal_epoch: "worker-terminal-rehosted".into(),
    };
    fs::write(
        state
            .hmux_identity
            .discovery_root
            .join("current-session.json"),
        serde_json::to_vec(&json!({
            "schema_version": 1,
            "session_id": target.session_id,
            "workspace_id": target.workspace_id,
            "session_class": "managed",
            "lifecycle": "ready",
            "provider_id": target.provider_id,
            "runner_principal": target.runner_principal,
            "runner_instance": target.runner_instance,
            "channel_epoch": target.channel_epoch,
            "host_instance_id": target.host_instance_id,
            "terminal_epoch": target.terminal_epoch,
            "health": "healthy",
        }))
        .unwrap(),
    )
    .unwrap();
    complete_fixture_managed_create(&state, &target, "worker-create-rehosted");
    let body = json!({
        "schemaVersion": 1,
        "operationId": "permission-mode-relaunch-1",
        "source": source,
        "target": target,
        "reboundAtMs": 1_200,
    });
    let inspection = invoke_orchestration(
        &state,
        "dispatch-session-inspect-source",
        "dispatch.session.inspect",
        json!({ "schemaVersion": 1, "session": source }),
    )
    .await;
    assert_eq!(inspection["receipt"]["outcome"], "active_dispatch");
    assert_eq!(
        inspection["receipt"]["target"]["dispatchId"],
        active.dispatch_id.as_str()
    );

    let first = invoke_orchestration(
        &state,
        "dispatch-session-rebind-1",
        "dispatch.session.rebind",
        body.clone(),
    )
    .await;
    assert_eq!(first["receipt"]["outcome"], "rebound");
    assert_eq!(first["receipt"]["taskId"], active.task_id.as_str());
    assert_eq!(first["receipt"]["dispatchId"], active.dispatch_id.as_str());
    assert_eq!(first["receipt"]["generation"], active.generation);
    assert_eq!(first["receipt"]["source"], body["source"]);
    assert_eq!(first["receipt"]["target"], body["target"]);

    let replay = invoke_orchestration(
        &state,
        "dispatch-session-rebind-replay",
        "dispatch.session.rebind",
        body.clone(),
    )
    .await;
    assert_eq!(replay["receipt"], first["receipt"]);

    let rebound = state
        .store
        .delegate_once_receipt_for_dispatch(&active.task_id, &active.dispatch_id, active.generation)
        .await
        .unwrap();
    assert_eq!(rebound.session.as_ref().unwrap(), &target);
    assert_eq!(
        rebound.effective_launch_idempotency_key.as_deref(),
        Some("worker-create-rehosted")
    );
    assert_eq!(
        rebound.launch_idempotency_key,
        active.launch_idempotency_key
    );
    let context = invoke_orchestration(
        &state,
        "dispatch-session-rebind-context",
        "dispatch.context.get",
        json!({ "schemaVersion": 1, "session": target }),
    )
    .await;
    assert_eq!(
        context["receipt"]["target"]["taskId"],
        active.task_id.as_str()
    );

    let stale = dispatch(
        &state,
        &orchestration_backend_request(
            &state,
            "dispatch-session-rebind-stale-source",
            "dispatch.context.get",
            json!({ "schemaVersion": 1, "session": source }),
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(stale.code, "orchestration_generation_conflict");
    assert_eq!(
        stale.disposition,
        BackendFailureDispositionV1::StaleGeneration
    );

    let batch = invoke_orchestration(
        &state,
        "dispatch-session-rebind-context-batch",
        "dispatch.context.get.batch",
        json!({ "schemaVersion": 1, "sessions": [target, source] }),
    )
    .await;
    assert_eq!(batch["receipt"]["results"][0]["outcome"], "found");
    assert_eq!(
        batch["receipt"]["results"][0]["context"],
        context["receipt"]
    );
    assert_eq!(batch["receipt"]["results"][1]["outcome"], "failed");
    assert_eq!(
        batch["receipt"]["results"][1]["error"]["details"]["disposition"],
        "stale_generation"
    );
}

#[tokio::test]
async fn active_dispatch_rebinds_after_idempotency_schema_defaults_evolve() {
    let (root, state, _launcher, _prompt_deliverer) =
        fixture_with_delivery(Vec::new(), Vec::new()).await;
    let active = invoke_orchestration(
        &state,
        "run-create-before-idempotency-schema-evolution",
        "run.create",
        existing_session_run_body(),
    )
    .await;
    let legacy_pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(root.path().join("domain.sqlite")),
    )
    .await
    .unwrap();
    let rewritten = sqlx::query(
        r#"
        UPDATE workflow_interaction_idempotency
        SET entry_json = json_remove(
            entry_json,
            '$.receipt.receipt.context.dispatchState',
            '$.receipt.receipt.context.successorRequired'
        )
        "#,
    )
    .execute(&legacy_pool)
    .await
    .unwrap();
    assert_eq!(rewritten.rows_affected(), 1);
    legacy_pool.close().await;

    let source: WorkflowSessionGenerationV1 =
        serde_json::from_value(existing_session_run_body()["session"].clone()).unwrap();
    let target = WorkflowSessionGenerationV1 {
        session_id: "worker-session-rehosted-after-schema-evolution".into(),
        workspace_id: source.workspace_id.clone(),
        provider_id: source.provider_id.clone(),
        runner_principal: source.runner_principal.clone(),
        runner_instance: "worker-instance-rehosted-after-schema-evolution".into(),
        channel_epoch: "3".into(),
        host_instance_id: "worker-host-rehosted-after-schema-evolution".into(),
        terminal_epoch: "worker-terminal-rehosted-after-schema-evolution".into(),
    };
    fs::write(
        state
            .hmux_identity
            .discovery_root
            .join("current-session.json"),
        serde_json::to_vec(&json!({
            "schema_version": 1,
            "session_id": target.session_id,
            "workspace_id": target.workspace_id,
            "session_class": "managed",
            "lifecycle": "ready",
            "provider_id": target.provider_id,
            "runner_principal": target.runner_principal,
            "runner_instance": target.runner_instance,
            "channel_epoch": target.channel_epoch,
            "host_instance_id": target.host_instance_id,
            "terminal_epoch": target.terminal_epoch,
            "health": "healthy",
        }))
        .unwrap(),
    )
    .unwrap();
    let rebound = invoke_orchestration(
        &state,
        "dispatch-session-rebind-after-schema-evolution",
        "dispatch.session.rebind",
        json!({
            "schemaVersion": 1,
            "operationId": "rehost-after-idempotency-schema-evolution",
            "source": source,
            "target": target,
            "reboundAtMs": 1_200,
        }),
    )
    .await;

    assert_eq!(rebound["receipt"]["outcome"], "rebound");
    assert_eq!(
        rebound["receipt"]["dispatchId"],
        active["receipt"]["context"]["target"]["dispatchId"]
    );
}

#[tokio::test]
async fn pty_rebind_rejects_a_successor_paired_with_the_prepared_root_before_writing() {
    let (_root, state, _launcher, _prompt_deliverer) = fixture(vec![LaunchOutcome::Succeed]).await;
    let active = receipt(&delegate_once(&state, request()).await.unwrap());
    let source = active.session.clone().unwrap();
    let target = WorkflowSessionGenerationV1 {
        session_id: "worker-session-rehosted".into(),
        workspace_id: source.workspace_id.clone(),
        provider_id: source.provider_id.clone(),
        runner_principal: source.runner_principal.clone(),
        runner_instance: "worker-instance-rehosted".into(),
        channel_epoch: "3".into(),
        host_instance_id: "worker-host-rehosted".into(),
        terminal_epoch: "worker-terminal-rehosted".into(),
    };
    let error = state
        .store
        .rebind_orchestration_dispatch_session(
            &dure_app_sqlite::OrchestrationDispatchSessionRebindRequestV1 {
                schema_version: 1,
                operation_id: "invalid-successor-root-pair".into(),
                source: source.clone(),
                target,
                rebound_at_ms: 1_200,
            },
            Some(&active.launch_idempotency_key),
        )
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        dure_app::DomainStoreErrorV1::InvalidRecord {
            field: "effectiveLaunchIdempotencyKey",
            ..
        }
    ));
    let persisted = state
        .store
        .delegate_once_receipt_for_dispatch(&active.task_id, &active.dispatch_id, active.generation)
        .await
        .unwrap();
    assert_eq!(persisted.session.as_ref(), Some(&source));
    assert_eq!(
        persisted.effective_launch_idempotency_key,
        active.effective_launch_idempotency_key
    );
}

#[tokio::test]
async fn current_pty_dispatch_with_an_effective_key_does_not_require_the_hmux_ledger() {
    let (_root, state, _launcher, _prompt_deliverer) = fixture(vec![LaunchOutcome::Advanced {
        session_id: "worker-session-rehosted",
        launch_idempotency_key: "worker-create-rehosted",
    }])
    .await;
    let active = receipt(&delegate_once(&state, request()).await.unwrap());
    let target = active.session.clone().unwrap();
    fs::write(
        state
            .hmux_identity
            .discovery_root
            .join("current-session.json"),
        serde_json::to_vec(&json!({
            "schema_version": 1,
            "session_id": target.session_id,
            "workspace_id": target.workspace_id,
            "session_class": "managed",
            "lifecycle": "ready",
            "provider_id": target.provider_id,
            "runner_principal": target.runner_principal,
            "runner_instance": target.runner_instance,
            "channel_epoch": target.channel_epoch,
            "host_instance_id": target.host_instance_id,
            "terminal_epoch": target.terminal_epoch,
            "health": "healthy",
        }))
        .unwrap(),
    )
    .unwrap();

    let reconciled = invoke_orchestration(
        &state,
        "current-pty-without-create-ledger",
        "dispatch.session.reconcile-rehost",
        json!({
            "schemaVersion": 1,
            "expected": {
                "taskId": active.task_id,
                "dispatchId": active.dispatch_id,
                "generation": active.generation,
            },
            "target": target,
            "reconciledAtMs": 1_200,
        }),
    )
    .await;
    assert_eq!(reconciled["receipt"]["outcome"], "current");
    let persisted = state
        .store
        .delegate_once_receipt("workflow-control-plane-1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        persisted.effective_launch_idempotency_key.as_deref(),
        Some("worker-create-rehosted")
    );
}

#[tokio::test]
async fn projected_dispatch_reconciles_from_durable_rehost_lineage() {
    let (root, state, _launcher, _prompt_deliverer) = fixture(vec![LaunchOutcome::Succeed]).await;
    let active = receipt(&delegate_once(&state, request()).await.unwrap());
    bind_fixture_worker_context(&state, &active).await;
    let source = active.session.clone().unwrap();
    let target = WorkflowSessionGenerationV1 {
        session_id: "worker-session-rehosted".into(),
        workspace_id: source.workspace_id.clone(),
        provider_id: source.provider_id.clone(),
        runner_principal: source.runner_principal.clone(),
        runner_instance: "worker-instance-rehosted".into(),
        channel_epoch: "3".into(),
        host_instance_id: "worker-host-rehosted".into(),
        terminal_epoch: "worker-terminal-rehosted".into(),
    };
    let discovery_root = root.path().join("discovery");
    fs::write(
        discovery_root.join("current-session.json"),
        serde_json::to_vec(&json!({
            "schema_version": 1,
            "session_id": target.session_id,
            "workspace_id": target.workspace_id,
            "session_class": "managed",
            "lifecycle": "ready",
            "provider_id": target.provider_id,
            "runner_principal": target.runner_principal,
            "runner_instance": target.runner_instance,
            "channel_epoch": target.channel_epoch,
            "host_instance_id": target.host_instance_id,
            "terminal_epoch": target.terminal_epoch,
            "health": "healthy",
        }))
        .unwrap(),
    )
    .unwrap();
    complete_fixture_managed_create(&state, &target, "worker-create-rehosted");
    fs::write(
        discovery_root.join("rehost-resolution.json"),
        serde_json::to_vec(&json!({
            "schema": "hmux-managed-rehost-resolution-v1",
            "schemaVersion": 1,
            "state": "resolved",
            "operationIds": ["rehost-operation-1"],
            "sourceGeneration": source,
            "currentGeneration": target,
            "providerId": "codex",
            "permissionMode": "default",
        }))
        .unwrap(),
    )
    .unwrap();

    let reconciled = invoke_orchestration(
        &state,
        "dispatch-session-reconcile-rehost",
        "dispatch.session.reconcile-rehost",
        json!({
            "schemaVersion": 1,
            "expected": {
                "taskId": active.task_id,
                "dispatchId": active.dispatch_id,
                "generation": active.generation,
            },
            "target": target,
            "reconciledAtMs": 1_200,
        }),
    )
    .await;

    assert_eq!(reconciled["receipt"]["outcome"], "rebound");
    assert_eq!(
        reconciled["receipt"]["dispatchId"],
        active.dispatch_id.as_str()
    );
    assert_eq!(reconciled["receipt"]["target"], json!(target));
}

#[tokio::test]
async fn completed_projected_dispatch_reconciles_before_one_successor_enrollment() {
    let (root, state, launcher, prompt_deliverer) =
        fixture_with_delivery(Vec::new(), Vec::new()).await;
    let created = invoke_orchestration(
        &state,
        "run-create-completed-rehost-source",
        "run.create",
        existing_session_run_body(),
    )
    .await;
    let completed_context = created["receipt"]["context"].clone();
    let completed = invoke_orchestration(
        &state,
        "run-complete-before-rehost",
        "dispatch.complete",
        json!({
            "schemaVersion": 1,
            "idempotencyKey": "run-complete-before-rehost",
            "messageId": "completion-before-rehost",
            "target": completed_context["target"],
            "expectedDispatchRevision": 1,
            "completedBy": completed_context["participant"],
            "endpointFence": completed_context["endpointFence"],
            "audience": { "grants": [completed_context["coordinatorGrant"].clone()] },
            "completionCapability": completed_context["completionCapability"],
            "title": "Reporting cycle complete",
            "resultMarkdown": "The reporting cycle completed before rehost.",
            "completedAtMs": 1_100
        }),
    )
    .await;
    assert_eq!(completed["receipt"]["dispatchState"], "completed");
    invoke_orchestration(
        &state,
        "run-events-observe-completed-before-rehost",
        "events.read",
        json!({
            "schemaVersion": 1,
            "authority": completed_context["target"]["authority"],
            "target": completed_context["target"],
            "participant": completed_context["coordinatorGrant"]["participant"],
            "deliveryCapability": completed_context["coordinatorGrant"]["deliveryCapability"],
            "after": 0,
            "limit": 128
        }),
    )
    .await;
    let observed_source = invoke_orchestration(
        &state,
        "run-context-observed-completed-before-rehost",
        "dispatch.context.get",
        json!({
            "schemaVersion": 1,
            "session": existing_session_run_body()["session"].clone()
        }),
    )
    .await;
    assert_eq!(observed_source["receipt"]["dispatchState"], "completed");
    assert_eq!(observed_source["receipt"]["successorRequired"], true);

    let source: WorkflowSessionGenerationV1 =
        serde_json::from_value(existing_session_run_body()["session"].clone()).unwrap();
    let target = WorkflowSessionGenerationV1 {
        session_id: "coordinator-session-rehosted".into(),
        workspace_id: source.workspace_id.clone(),
        provider_id: source.provider_id.clone(),
        runner_principal: source.runner_principal.clone(),
        runner_instance: "coordinator-instance-rehosted".into(),
        channel_epoch: "2".into(),
        host_instance_id: "coordinator-host-rehosted".into(),
        terminal_epoch: "coordinator-terminal-rehosted".into(),
    };
    let discovery_root = root.path().join("discovery");
    fs::write(
        discovery_root.join("current-session.json"),
        serde_json::to_vec(&json!({
            "schema_version": 1,
            "session_id": target.session_id,
            "workspace_id": target.workspace_id,
            "session_class": "managed",
            "lifecycle": "ready",
            "provider_id": target.provider_id,
            "runner_principal": target.runner_principal,
            "runner_instance": target.runner_instance,
            "channel_epoch": target.channel_epoch,
            "host_instance_id": target.host_instance_id,
            "terminal_epoch": target.terminal_epoch,
            "health": "healthy",
        }))
        .unwrap(),
    )
    .unwrap();
    fs::write(
        discovery_root.join("rehost-resolution.json"),
        serde_json::to_vec(&json!({
            "schema": "hmux-managed-rehost-resolution-v1",
            "schemaVersion": 1,
            "state": "resolved",
            "operationIds": ["completed-reporting-rehost-1"],
            "sourceGeneration": source,
            "currentGeneration": target,
            "providerId": "codex",
            "permissionMode": "default",
        }))
        .unwrap(),
    )
    .unwrap();
    state
        .store
        .upsert_agent_checkpoint_binding_authority(&AgentCheckpointBindingAuthorityV1 {
            schema_version: AGENT_CHECKPOINT_SCHEMA_VERSION_V1,
            binding: SessionBindingRecordV1 {
                agent_id: AgentIdV1::new("coordinator-1").unwrap(),
                runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
                session_id: target.session_id.clone(),
                provider_conversation_id: None,
                credential_reference_id: None,
                binding_generation: 2,
                bound_at_ms: 1_150,
            },
            runtime_workspace_id: target.workspace_id.clone(),
            runner_principal: target.runner_principal.clone(),
            runner_instance: target.runner_instance.clone(),
            channel_epoch: target.channel_epoch.clone(),
            host_instance_id: target.host_instance_id.clone(),
            terminal_epoch: target.terminal_epoch.clone(),
            updated_at_ms: 1_150,
        })
        .await
        .unwrap();

    let reconciled = invoke_orchestration(
        &state,
        "dispatch-session-reconcile-completed-rehost",
        "dispatch.session.reconcile-rehost",
        json!({
            "schemaVersion": 1,
            "expected": {
                "taskId": completed_context["target"]["taskId"],
                "dispatchId": completed_context["target"]["dispatchId"],
                "generation": completed_context["target"]["generation"],
            },
            "target": target,
            "reconciledAtMs": 1_200,
        }),
    )
    .await;
    assert_eq!(reconciled["receipt"]["outcome"], "rebound");
    assert_eq!(
        reconciled["receipt"]["dispatchId"],
        completed_context["target"]["dispatchId"]
    );
    assert_eq!(reconciled["receipt"]["target"], json!(target));
    let reconcile_replay = invoke_orchestration(
        &state,
        "dispatch-session-reconcile-completed-rehost-replay",
        "dispatch.session.reconcile-rehost",
        json!({
            "schemaVersion": 1,
            "expected": {
                "taskId": completed_context["target"]["taskId"],
                "dispatchId": completed_context["target"]["dispatchId"],
                "generation": completed_context["target"]["generation"],
            },
            "target": target,
            "reconciledAtMs": 1_200,
        }),
    )
    .await;
    assert_eq!(reconcile_replay["receipt"]["outcome"], "current");
    assert_eq!(
        reconcile_replay["receipt"]["dispatchId"],
        completed_context["target"]["dispatchId"]
    );

    let rebound = invoke_orchestration(
        &state,
        "run-context-completed-after-rehost",
        "dispatch.context.get",
        json!({ "schemaVersion": 1, "session": target }),
    )
    .await;
    assert_eq!(rebound["receipt"]["target"], completed_context["target"]);
    assert_eq!(rebound["receipt"]["dispatchState"], "completed");
    assert_eq!(rebound["receipt"]["successorRequired"], true);
    assert_eq!(
        rebound["receipt"]["endpointFence"]["sessionIdentity"],
        serde_json::to_value(orchestration_session_identity(&target).unwrap()).unwrap()
    );

    let mut successor_body = existing_session_run_body();
    successor_body["session"] = serde_json::to_value(&target).unwrap();
    successor_body["idempotencyKey"] = json!("run-create-completed-rehost-successor");
    successor_body["createdAtMs"] = json!(1_300);
    let successor = invoke_orchestration(
        &state,
        "run-create-completed-rehost-successor",
        "run.create",
        successor_body.clone(),
    )
    .await;
    let replay = invoke_orchestration(
        &state,
        "run-create-completed-rehost-successor-replay",
        "run.create",
        successor_body,
    )
    .await;
    assert_eq!(replay["receipt"]["idempotent"], true);
    assert_eq!(
        replay["receipt"]["context"],
        successor["receipt"]["context"]
    );
    assert_ne!(
        successor["receipt"]["context"]["target"],
        completed_context["target"]
    );

    let verification_pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new()
            .filename(root.path().join("domain.sqlite"))
            .read_only(true),
    )
    .await
    .unwrap();
    let run_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM workflow_runs WHERE contribution_id = 'workflow.existing-session-reporting'",
    )
    .fetch_one(&verification_pool)
    .await
    .unwrap();
    let active_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM workflow_dispatches WHERE state = 'starting'")
            .fetch_one(&verification_pool)
            .await
            .unwrap();
    assert_eq!((run_count, active_count), (2, 1));
    verification_pool.close().await;
    assert!(launcher.requests().is_empty());
    assert!(prompt_deliverer.requests().is_empty());
}

#[tokio::test]
async fn stalled_or_failed_activity_is_durable_and_never_resends_the_prompt() {
    for (outcome, expected_state, expected_code) in [
        (
            ActivityOutcome::Stalled("8"),
            WorkflowPromptActivityStateV1::Stalled,
            "workflow_prompt_stalled",
        ),
        (
            ActivityOutcome::Fail("workflow_prompt_activity_replay_gap", "10"),
            WorkflowPromptActivityStateV1::Failed,
            "workflow_prompt_activity_replay_gap",
        ),
    ] {
        let (_root, state, launcher, prompt_deliverer, activity_observer) =
            fixture_with_observation(
                vec![LaunchOutcome::Succeed],
                vec![DeliveryOutcome::Succeed],
                vec![outcome],
            )
            .await;
        let first = receipt(&delegate_once(&state, request()).await.unwrap());
        let activity = first
            .prompt_delivery
            .as_ref()
            .unwrap()
            .evidence
            .as_ref()
            .unwrap()
            .activity()
            .unwrap();
        assert_eq!(activity.state, expected_state);
        assert_eq!(activity.error_code.as_deref(), Some(expected_code));

        assert_eq!(
            receipt(&delegate_once(&state, request()).await.unwrap()),
            first
        );
        assert_eq!(launcher.requests().len(), 1);
        assert_eq!(prompt_deliverer.requests().len(), 1);
        assert_eq!(activity_observer.requests().len(), 1);
    }
}

#[tokio::test]
async fn uncertain_response_stays_starting_and_replays_the_same_hmux_identity() {
    let (_root, state, launcher, prompt_deliverer) = fixture(vec![
        LaunchOutcome::Fail("hmux_managed_runtime_failed"),
        LaunchOutcome::Succeed,
    ])
    .await;
    let error = delegate_once(&state, request()).await.unwrap_err();
    assert_eq!(error.code, "hmux_managed_runtime_failed");
    assert_eq!(
        state
            .store
            .delegate_once_receipt("workflow-control-plane-1")
            .await
            .unwrap()
            .unwrap()
            .status,
        WorkflowDispatchStateV1::Starting
    );

    let replay = receipt(&delegate_once(&state, request()).await.unwrap());
    assert_eq!(replay.status, WorkflowDispatchStateV1::Active);
    let requests = launcher.requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[0].launch_idempotency_key,
        requests[1].launch_idempotency_key
    );
    assert_eq!(requests[0].session_id, requests[1].session_id);
    assert_eq!(prompt_deliverer.requests().len(), 1);
}

#[tokio::test]
async fn coordinator_mismatch_fails_before_workflow_or_hmux_mutation() {
    let (_root, state, launcher, _prompt_deliverer) = fixture(Vec::new()).await;
    let mut mismatched = request();
    mismatched.coordinator.binding_generation = 2;
    let error = delegate_once(&state, mismatched).await.unwrap_err();
    assert_eq!(error.code, "workflow_coordinator_binding_mismatch");
    assert!(
        state
            .store
            .delegate_once_receipt("workflow-control-plane-1")
            .await
            .unwrap()
            .is_none()
    );
    assert!(launcher.requests().is_empty());
}

#[tokio::test]
async fn target_runtime_and_provider_preflight_fail_before_persistence() {
    let (_root, state, launcher, _prompt_deliverer) = fixture(Vec::new()).await;
    let mut cases = Vec::new();

    let mut target = request();
    target.idempotency_key = "workflow-invalid-target".into();
    target.target_reference = "backend-profile:remote".into();
    cases.push((target, "workflow_target_unavailable"));

    let mut runtime = request();
    runtime.idempotency_key = "workflow-invalid-runtime".into();
    runtime.runtime_kind_id = RuntimeKindIdV1::new("runtime.missing").unwrap();
    cases.push((runtime, "workflow_runtime_unavailable"));

    let mut provider = request();
    provider.idempotency_key = "workflow-invalid-provider".into();
    provider.provider_id = ProviderIdV1::new("gemini").unwrap();
    cases.push((provider, "workflow_provider_unavailable"));

    for (invalid, expected_code) in cases {
        let key = invalid.idempotency_key.clone();
        let error = delegate_once(&state, invalid).await.unwrap_err();
        assert_eq!(error.code, expected_code);
        assert_eq!(error.disposition, BackendFailureDispositionV1::Terminal);
        assert!(
            state
                .store
                .delegate_once_receipt(&key)
                .await
                .unwrap()
                .is_none()
        );
    }
    assert!(launcher.requests().is_empty());
}

#[tokio::test]
async fn definitive_hmux_refusal_is_durable_and_recoverable_without_relaunch() {
    let (_root, state, launcher, _prompt_deliverer) =
        fixture(vec![LaunchOutcome::Reject("hmux_managed_create_refused")]).await;
    let failed = receipt(&delegate_once(&state, request()).await.unwrap());
    assert_eq!(failed.status, WorkflowDispatchStateV1::StartFailed);
    assert_eq!(
        failed.start_error_code.as_deref(),
        Some("hmux_managed_create_refused")
    );
    assert_eq!(
        receipt(&delegate_once(&state, request()).await.unwrap()),
        failed
    );
    assert_eq!(launcher.requests().len(), 1);
}

#[tokio::test]
async fn uncertain_prompt_write_is_never_replayed() {
    let (_root, state, launcher, prompt_deliverer) = fixture_with_delivery(
        vec![LaunchOutcome::Succeed],
        vec![DeliveryOutcome::Fail("hmux_input_receipt_timeout", true)],
    )
    .await;
    let error = delegate_once(&state, request()).await.unwrap_err();
    assert_eq!(error.code, "hmux_input_receipt_timeout");
    let uncertain = state
        .store
        .delegate_once_receipt("workflow-control-plane-1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        uncertain.prompt_delivery.as_ref().unwrap().state,
        WorkflowPromptDeliveryStateV1::Uncertain
    );

    let replay = receipt(&delegate_once(&state, request()).await.unwrap());
    assert_eq!(replay, uncertain);
    assert_eq!(launcher.requests().len(), 1);
    assert_eq!(prompt_deliverer.requests().len(), 1);
}

#[tokio::test]
async fn definitive_prompt_refusal_is_recorded_without_replay() {
    let (_root, state, launcher, prompt_deliverer) = fixture_with_delivery(
        vec![LaunchOutcome::Succeed],
        vec![DeliveryOutcome::Fail(
            "workflow_prompt_provider_blocked",
            false,
        )],
    )
    .await;
    let failed = receipt(&delegate_once(&state, request()).await.unwrap());
    let prompt = failed.prompt_delivery.as_ref().unwrap();
    assert_eq!(prompt.state, WorkflowPromptDeliveryStateV1::Failed);
    assert_eq!(
        prompt.error_code.as_deref(),
        Some("workflow_prompt_provider_blocked")
    );

    assert_eq!(
        receipt(&delegate_once(&state, request()).await.unwrap()),
        failed
    );
    assert_eq!(launcher.requests().len(), 1);
    assert_eq!(prompt_deliverer.requests().len(), 1);
}

fn orchestration_backend_request(
    state: &ServiceState,
    request_id: &str,
    method: &str,
    body: Value,
) -> BackendRequest {
    BackendRequest {
        schema_version: 1,
        api_version: BACKEND_PROTOCOL_API.into(),
        kind: BACKEND_REQUEST_KIND.into(),
        request_id: request_id.into(),
        operation: "orchestration.invoke".into(),
        expected: ExpectedBackend {
            scope_id: None,
            backend_id: BACKEND_ID.into(),
            generation: state.descriptor.generation.clone(),
            protocol: ExpectedProtocol {
                minimum: ProtocolVersion { major: 1, minor: 0 },
                maximum: ProtocolVersion { major: 1, minor: 0 },
            },
            required_capabilities: vec!["orchestration.invoke".into()],
        },
        body: json!({
            "apiVersion": "dure.orchestration/v1",
            "method": method,
            "body": body,
        }),
        connection: None,
    }
}

async fn invoke_orchestration(
    state: &ServiceState,
    request_id: &str,
    method: &str,
    body: Value,
) -> Value {
    dispatch(
        state,
        &orchestration_backend_request(state, request_id, method, body),
    )
    .await
    .unwrap_or_else(|error| panic!("orchestration method {method} failed: {error:?}"))
}

async fn bind_fixture_worker_context(
    state: &ServiceState,
    active: &DelegateOnceReceiptV1,
) -> Value {
    let target = json!({
        "authority": { "workspaceId": "workspace-1" },
        "runId": active.run_id,
        "taskId": active.task_id,
        "dispatchId": active.dispatch_id,
        "generation": active.generation,
    });
    invoke_orchestration(
        state,
        "orchestration-context-worker",
        "dispatch.context",
        json!({
            "schemaVersion": 1,
            "target": target,
            "session": active.session,
            "integrationReceipt": {
                "installRootRef": "install-root-fixture",
                "version": "fixture-v1",
                "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "channel": "test",
                "capabilities": [
                    "event_cursor_v1",
                    "idempotent_delivery_receipt_v1",
                    "interaction_message_v1",
                    "interaction_decision_v1",
                    "mcp_stdio_v1"
                ]
            },
            "idempotencyKey": "bind-worker-context-1",
            "resolvedAtMs": 1_100
        }),
    )
    .await
}

fn existing_session_run_body() -> Value {
    json!({
        "schemaVersion": 1,
        "workflowKindRef": "workflow.existing-session-reporting",
        "task": {
            "summary": "Report the current managed session",
            "instructions": "Publish durable Markdown updates and decisions through the orchestration service."
        },
        "session": {
            "sessionId": "coordinator-session",
            "workspaceId": "coordinator-workspace",
            "providerId": "codex",
            "runnerPrincipal": "coordinator-runner",
            "runnerInstance": "coordinator-instance",
            "channelEpoch": "1",
            "hostInstanceId": "coordinator-host",
            "terminalEpoch": "coordinator-terminal"
        },
        "integrationReceipt": {
            "installRootRef": "install-codex-fixture",
            "version": "fixture-v1",
            "digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "channel": "test",
            "capabilities": [
                "event_cursor_v1",
                "idempotent_delivery_receipt_v1",
                "interaction_message_v1",
                "interaction_decision_v1",
                "mcp_stdio_v1"
            ]
        },
        "runtimeRef": "runtime.hmux",
        "targetReference": "orchestration.current-session",
        "idempotencyKey": "run-create-existing-session-1",
        "createdAtMs": 1_050
    })
}

#[tokio::test]
async fn existing_exact_session_creates_one_durable_reporting_run_without_pty_delivery() {
    let (root, state, launcher, prompt_deliverer) =
        fixture_with_delivery(Vec::new(), Vec::new()).await;

    let unassigned = dispatch(
        &state,
        &orchestration_backend_request(
            &state,
            "run-context-unassigned-session",
            "dispatch.context.get",
            json!({
                "schemaVersion": 1,
                "session": existing_session_run_body()["session"].clone()
            }),
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(unassigned.code, "orchestration_generation_conflict");
    assert_eq!(
        unassigned.disposition,
        BackendFailureDispositionV1::Unassigned
    );
    let wire_error = backend_error_body(unassigned);
    assert_eq!(wire_error["code"], "orchestration_generation_conflict");
    assert_eq!(wire_error["details"]["disposition"], "unassigned");

    let fault_pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(root.path().join("domain.sqlite")),
    )
    .await
    .unwrap();
    sqlx::query(
        r#"
        CREATE TRIGGER fail_run_created_event
        BEFORE INSERT ON workflow_interaction_events
        WHEN json_extract(NEW.event_json, '$.kind.kind') = 'run_created'
        BEGIN
            SELECT RAISE(ABORT, 'fault-injected run Event');
        END
        "#,
    )
    .execute(&fault_pool)
    .await
    .unwrap();
    let transaction_error = dispatch(
        &state,
        &orchestration_backend_request(
            &state,
            "run-create-existing-session-fault",
            "run.create",
            existing_session_run_body(),
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(transaction_error.code, "orchestration_store_unavailable");
    let canonical_runs: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM workflow_runs WHERE contribution_id = 'workflow.existing-session-reporting'",
    )
    .fetch_one(&fault_pool)
    .await
    .unwrap();
    let audit_events: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM workflow_interaction_events WHERE json_extract(event_json, '$.kind.kind') = 'run_created'",
    )
    .fetch_one(&fault_pool)
    .await
    .unwrap();
    assert_eq!((canonical_runs, audit_events), (0, 0));
    sqlx::query("DROP TRIGGER fail_run_created_event")
        .execute(&fault_pool)
        .await
        .unwrap();
    fault_pool.close().await;

    let created = invoke_orchestration(
        &state,
        "run-create-existing-session",
        "run.create",
        existing_session_run_body(),
    )
    .await;
    let context = &created["receipt"]["context"];
    assert_eq!(created["method"], "run.create");
    assert_eq!(created["receipt"]["idempotent"], false);
    assert_eq!(created["receipt"]["event"]["kind"]["kind"], "run_created");
    assert_eq!(context["endpointFence"]["generation"], 1);
    assert_eq!(launcher.requests().len(), 0);
    assert_eq!(prompt_deliverer.requests().len(), 0);

    let events = invoke_orchestration(
        &state,
        "run-events-existing-session",
        "events.read",
        json!({
            "schemaVersion": 1,
            "authority": context["target"]["authority"],
            "target": context["target"],
            "participant": context["coordinatorGrant"]["participant"],
            "deliveryCapability": context["coordinatorGrant"]["deliveryCapability"],
            "after": 0,
            "limit": 128
        }),
    )
    .await;
    assert_eq!(
        events["receipt"]["events"][0]["kind"]["kind"],
        "run_created"
    );
    assert_eq!(events["receipt"]["nextCursor"], 1);
    assert_eq!(events["receipt"]["deliveries"][0]["state"], "observed");

    let reopened = invoke_orchestration(
        &state,
        "run-context-existing-session",
        "dispatch.context.get",
        json!({
            "schemaVersion": 1,
            "session": existing_session_run_body()["session"].clone()
        }),
    )
    .await;
    assert_eq!(reopened["receipt"], *context);

    let mut retry_body = existing_session_run_body();
    retry_body["createdAtMs"] = json!(1_075);
    let replay = invoke_orchestration(
        &state,
        "run-create-existing-session-replay",
        "run.create",
        retry_body,
    )
    .await;
    assert_eq!(replay["receipt"]["context"], *context);
    assert_eq!(replay["receipt"]["idempotent"], true);
    assert_eq!(launcher.requests().len(), 0);
    assert_eq!(prompt_deliverer.requests().len(), 0);

    let mut replaced_session = existing_session_run_body();
    replaced_session["idempotencyKey"] = json!("run-create-existing-session-replaced");
    replaced_session["session"]["terminalEpoch"] = json!("replacement-terminal");
    let generation_error = dispatch(
        &state,
        &orchestration_backend_request(
            &state,
            "run-create-existing-session-replaced",
            "run.create",
            replaced_session,
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(generation_error.code, "orchestration_generation_conflict");

    let mut replaced_capability = existing_session_run_body();
    replaced_capability["integrationReceipt"]["digest"] = json!("b".repeat(64));
    let idempotency_error = dispatch(
        &state,
        &orchestration_backend_request(
            &state,
            "run-create-existing-session-capability-conflict",
            "run.create",
            replaced_capability,
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(idempotency_error.code, "orchestration_idempotency_conflict");
}

#[tokio::test]
async fn durable_inbox_current_reconcile_ignores_a_shared_pty_create_authority() {
    let (_root, state, _launcher, _prompt_deliverer) = fixture(vec![LaunchOutcome::Succeed]).await;
    let created = invoke_orchestration(
        &state,
        "run-create-durable-current-reconcile",
        "run.create",
        existing_session_run_body(),
    )
    .await;
    let context = created["receipt"]["context"].clone();
    let source: WorkflowSessionGenerationV1 =
        serde_json::from_value(existing_session_run_body()["session"].clone()).unwrap();
    let pty = receipt(&delegate_once(&state, request()).await.unwrap());
    let pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(&state.descriptor.database_path),
    )
    .await
    .unwrap();
    let updated = sqlx::query(
        r#"
        UPDATE workflow_dispatch_launches
        SET session_id = ?1,
            workspace_id = ?2,
            provider_id = ?3,
            runner_principal = ?4,
            runner_instance = ?5,
            channel_epoch = ?6,
            host_instance_id = ?7,
            terminal_epoch = ?8,
            effective_launch_idempotency_key = 'shared-pty-effective'
        WHERE dispatch_id = ?9
        "#,
    )
    .bind(&source.session_id)
    .bind(&source.workspace_id)
    .bind(source.provider_id.as_str())
    .bind(&source.runner_principal)
    .bind(&source.runner_instance)
    .bind(&source.channel_epoch)
    .bind(&source.host_instance_id)
    .bind(&source.terminal_epoch)
    .bind(pty.dispatch_id.as_str())
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(updated.rows_affected(), 1);
    pool.close().await;

    let reconciled = invoke_orchestration(
        &state,
        "run-durable-current-reconcile",
        "dispatch.session.reconcile-rehost",
        json!({
            "schemaVersion": 1,
            "expected": {
                "taskId": context["target"]["taskId"],
                "dispatchId": context["target"]["dispatchId"],
                "generation": context["target"]["generation"],
            },
            "target": source,
            "reconciledAtMs": 1_200,
        }),
    )
    .await;
    assert_eq!(reconciled["receipt"]["outcome"], "current");
    assert_eq!(
        fixture_effective_launch(&state, context["target"]["dispatchId"].as_str().unwrap()).await,
        None
    );
    assert_eq!(
        fixture_effective_launch(&state, pty.dispatch_id.as_str()).await,
        Some("shared-pty-effective".into())
    );
}

#[tokio::test]
async fn durable_inbox_rebind_moves_only_the_session_without_a_create_receipt() {
    let (_root, state, _launcher, _prompt_deliverer) =
        fixture_with_delivery(Vec::new(), Vec::new()).await;
    let created = invoke_orchestration(
        &state,
        "run-create-durable-rebind",
        "run.create",
        existing_session_run_body(),
    )
    .await;
    let context = created["receipt"]["context"].clone();
    let source: WorkflowSessionGenerationV1 =
        serde_json::from_value(existing_session_run_body()["session"].clone()).unwrap();
    let target = WorkflowSessionGenerationV1 {
        session_id: "worker-session-rehosted".into(),
        workspace_id: source.workspace_id.clone(),
        provider_id: source.provider_id.clone(),
        runner_principal: source.runner_principal.clone(),
        runner_instance: "durable-rehosted-instance".into(),
        channel_epoch: "2".into(),
        host_instance_id: "durable-rehosted-host".into(),
        terminal_epoch: "durable-rehosted-terminal".into(),
    };
    fs::write(
        state
            .hmux_identity
            .discovery_root
            .join("current-session.json"),
        serde_json::to_vec(&json!({
            "schema_version": 1,
            "session_id": target.session_id,
            "workspace_id": target.workspace_id,
            "session_class": "managed",
            "lifecycle": "ready",
            "provider_id": target.provider_id,
            "runner_principal": target.runner_principal,
            "runner_instance": target.runner_instance,
            "channel_epoch": target.channel_epoch,
            "host_instance_id": target.host_instance_id,
            "terminal_epoch": target.terminal_epoch,
            "health": "healthy",
        }))
        .unwrap(),
    )
    .unwrap();

    let rebound = invoke_orchestration(
        &state,
        "run-durable-rebind",
        "dispatch.session.rebind",
        json!({
            "schemaVersion": 1,
            "operationId": "durable-inbox-rebind-1",
            "source": source,
            "target": target,
            "reboundAtMs": 1_200,
        }),
    )
    .await;
    assert_eq!(rebound["receipt"]["outcome"], "rebound");
    assert_eq!(rebound["receipt"]["target"], json!(target));
    assert_eq!(
        fixture_effective_launch(&state, context["target"]["dispatchId"].as_str().unwrap()).await,
        None
    );
    let persisted = state
        .store
        .orchestration_session_for_dispatch_target(
            &TaskIdV1::new(context["target"]["taskId"].as_str().unwrap()).unwrap(),
            &DispatchIdV1::new(context["target"]["dispatchId"].as_str().unwrap()).unwrap(),
            context["target"]["generation"].as_i64().unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(persisted, target);
}

#[tokio::test]
async fn mixed_durable_and_drainable_pty_rebind_uses_the_exact_target_create_key() {
    let (_root, mut state, _launcher, _prompt_deliverer) =
        fixture(vec![LaunchOutcome::Succeed]).await;
    let active = receipt(&delegate_once(&state, request()).await.unwrap());
    bind_fixture_worker_context(&state, &active).await;
    let source = active.session.clone().unwrap();
    let completed = receipt(
        &complete_delegate_once(
            &state,
            DelegateOnceCompleteBody {
                schema_version: DELEGATE_ONCE_SCHEMA_VERSION_V1,
                task_id: active.task_id.clone(),
                dispatch_id: active.dispatch_id.clone(),
                generation: active.generation,
                session: source.clone(),
                result: Some("PTY work completed.".into()),
            },
        )
        .await
        .unwrap(),
    );
    assert_eq!(completed.status, WorkflowDispatchStateV1::Completed);

    state
        .store
        .upsert_agent_checkpoint_binding_authority(&AgentCheckpointBindingAuthorityV1 {
            schema_version: AGENT_CHECKPOINT_SCHEMA_VERSION_V1,
            binding: SessionBindingRecordV1 {
                agent_id: AgentIdV1::new("coordinator-1").unwrap(),
                runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
                session_id: source.session_id.clone(),
                provider_conversation_id: None,
                credential_reference_id: None,
                binding_generation: 2,
                bound_at_ms: 1_250,
            },
            runtime_workspace_id: source.workspace_id.clone(),
            runner_principal: source.runner_principal.clone(),
            runner_instance: source.runner_instance.clone(),
            channel_epoch: source.channel_epoch.clone(),
            host_instance_id: source.host_instance_id.clone(),
            terminal_epoch: source.terminal_epoch.clone(),
            updated_at_ms: 1_250,
        })
        .await
        .unwrap();
    let current_session_path = state
        .hmux_identity
        .discovery_root
        .join("current-session.json");
    fs::write(
        &state.hmux_identity.executable_path,
        format!("#!/bin/sh\ncat '{}'\n", current_session_path.display()),
    )
    .unwrap();
    fs::set_permissions(
        &state.hmux_identity.executable_path,
        fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    state.hmux_identity = resolve_hmux_toolchain_identity(
        &state.hmux_identity.executable_path,
        &state.hmux_identity.runtime_executable_path,
        &state.hmux_identity.discovery_root,
    )
    .unwrap();
    fs::write(
        &current_session_path,
        serde_json::to_vec(&json!({
            "schema_version": 1,
            "session_id": source.session_id,
            "workspace_id": source.workspace_id,
            "session_class": "managed",
            "lifecycle": "ready",
            "provider_id": source.provider_id,
            "runner_principal": source.runner_principal,
            "runner_instance": source.runner_instance,
            "channel_epoch": source.channel_epoch,
            "host_instance_id": source.host_instance_id,
            "terminal_epoch": source.terminal_epoch,
            "health": "healthy",
        }))
        .unwrap(),
    )
    .unwrap();
    let mut durable_body = existing_session_run_body();
    durable_body["session"] = serde_json::to_value(&source).unwrap();
    durable_body["idempotencyKey"] = json!("run-create-mixed-rebind");
    durable_body["createdAtMs"] = json!(1_300);
    let durable = invoke_orchestration(
        &state,
        "run-create-mixed-rebind",
        "run.create",
        durable_body,
    )
    .await;
    let durable_context = durable["receipt"]["context"].clone();

    let target = WorkflowSessionGenerationV1 {
        session_id: "mixed-worker-successor".into(),
        workspace_id: source.workspace_id.clone(),
        provider_id: source.provider_id.clone(),
        runner_principal: source.runner_principal.clone(),
        runner_instance: "mixed-successor-instance".into(),
        channel_epoch: "3".into(),
        host_instance_id: "mixed-successor-host".into(),
        terminal_epoch: "mixed-successor-terminal".into(),
    };
    fs::write(
        &current_session_path,
        serde_json::to_vec(&json!({
            "schema_version": 1,
            "session_id": target.session_id,
            "workspace_id": target.workspace_id,
            "session_class": "managed",
            "lifecycle": "ready",
            "provider_id": target.provider_id,
            "runner_principal": target.runner_principal,
            "runner_instance": target.runner_instance,
            "channel_epoch": target.channel_epoch,
            "host_instance_id": target.host_instance_id,
            "terminal_epoch": target.terminal_epoch,
            "health": "healthy",
        }))
        .unwrap(),
    )
    .unwrap();
    complete_fixture_managed_create(&state, &target, "mixed-target-create");

    let rebound = invoke_orchestration(
        &state,
        "run-mixed-rebind",
        "dispatch.session.rebind",
        json!({
            "schemaVersion": 1,
            "operationId": "mixed-delivery-rebind-1",
            "source": source,
            "target": target,
            "reboundAtMs": 1_400,
        }),
    )
    .await;
    assert_eq!(rebound["receipt"]["outcome"], "rebound");
    assert_eq!(rebound["receipt"]["target"], json!(target));
    assert_eq!(
        fixture_effective_launch(
            &state,
            durable_context["target"]["dispatchId"].as_str().unwrap(),
        )
        .await,
        None
    );
    assert_eq!(
        fixture_effective_launch(&state, completed.dispatch_id.as_str()).await,
        Some("mixed-target-create".into())
    );
    let rebound_pty = state
        .store
        .delegate_once_receipt_for_dispatch(
            &completed.task_id,
            &completed.dispatch_id,
            completed.generation,
        )
        .await
        .unwrap();
    assert_eq!(rebound_pty.session.as_ref(), Some(&target));
    assert_eq!(
        rebound_pty.effective_launch_idempotency_key.as_deref(),
        Some("mixed-target-create")
    );
}

#[tokio::test]
async fn completed_reporting_dispatch_drains_before_returning_one_successor() {
    let (root, state, launcher, prompt_deliverer) =
        fixture_with_delivery(Vec::new(), Vec::new()).await;
    let first = invoke_orchestration(
        &state,
        "run-create-completed-session-first",
        "run.create",
        existing_session_run_body(),
    )
    .await;
    let first_context = first["receipt"]["context"].clone();

    let completion = invoke_orchestration(
        &state,
        "run-complete-existing-session-first",
        "dispatch.complete",
        json!({
            "schemaVersion": 1,
            "idempotencyKey": "run-complete-existing-session-first",
            "messageId": "completion-existing-session-first",
            "target": first_context["target"],
            "expectedDispatchRevision": 1,
            "completedBy": first_context["participant"],
            "endpointFence": first_context["endpointFence"],
            "audience": { "grants": [first_context["coordinatorGrant"].clone()] },
            "completionCapability": first_context["completionCapability"],
            "title": "Reporting cycle complete",
            "resultMarkdown": "The first reporting cycle is complete.",
            "completedAtMs": 1_100
        }),
    )
    .await;
    assert_eq!(completion["receipt"]["dispatchState"], "completed");

    let completed_context = invoke_orchestration(
        &state,
        "run-context-completed-session",
        "dispatch.context.get",
        json!({
            "schemaVersion": 1,
            "session": existing_session_run_body()["session"].clone()
        }),
    )
    .await;
    assert_eq!(completed_context["receipt"]["dispatchState"], "completed");
    assert_eq!(completed_context["receipt"]["successorRequired"], false);

    let inspection = invoke_orchestration(
        &state,
        "run-inspect-completed-session",
        "dispatch.session.inspect",
        json!({
            "schemaVersion": 1,
            "session": existing_session_run_body()["session"].clone()
        }),
    )
    .await;
    assert_eq!(inspection["receipt"]["outcome"], "unassigned");

    let mut successor_body = existing_session_run_body();
    successor_body["integrationReceipt"]["version"] = json!("fixture-v2");
    successor_body["idempotencyKey"] = json!("run-create-existing-session-2");
    successor_body["createdAtMs"] = json!(1_200);
    let successor = invoke_orchestration(
        &state,
        "run-create-completed-session-successor",
        "run.create",
        successor_body.clone(),
    )
    .await;
    assert_eq!(successor["receipt"]["idempotent"], false);
    assert_ne!(
        successor["receipt"]["context"]["target"],
        first_context["target"]
    );
    assert_eq!(
        successor["receipt"]["context"]["endpointFence"]["sessionIdentity"],
        first_context["endpointFence"]["sessionIdentity"]
    );

    let session: WorkflowSessionGenerationV1 =
        serde_json::from_value(existing_session_run_body()["session"].clone()).unwrap();
    let rehosted_session = WorkflowSessionGenerationV1 {
        session_id: "worker-session-rehosted".into(),
        workspace_id: session.workspace_id.clone(),
        provider_id: session.provider_id.clone(),
        runner_principal: session.runner_principal.clone(),
        runner_instance: "existing-runner-rehosted".into(),
        channel_epoch: "2".into(),
        host_instance_id: "existing-host-rehosted".into(),
        terminal_epoch: "existing-terminal-rehosted".into(),
    };
    fs::write(
        root.path().join("discovery/current-session.json"),
        serde_json::to_vec(&json!({
            "schema_version": 1,
            "session_id": rehosted_session.session_id,
            "workspace_id": rehosted_session.workspace_id,
            "session_class": "managed",
            "lifecycle": "ready",
            "provider_id": rehosted_session.provider_id,
            "runner_principal": rehosted_session.runner_principal,
            "runner_instance": rehosted_session.runner_instance,
            "channel_epoch": rehosted_session.channel_epoch,
            "host_instance_id": rehosted_session.host_instance_id,
            "terminal_epoch": rehosted_session.terminal_epoch,
            "health": "healthy",
        }))
        .unwrap(),
    )
    .unwrap();
    state
        .store
        .upsert_agent_checkpoint_binding_authority(&AgentCheckpointBindingAuthorityV1 {
            schema_version: AGENT_CHECKPOINT_SCHEMA_VERSION_V1,
            binding: SessionBindingRecordV1 {
                agent_id: AgentIdV1::new("coordinator-1").unwrap(),
                runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
                session_id: rehosted_session.session_id.clone(),
                provider_conversation_id: None,
                credential_reference_id: None,
                binding_generation: 2,
                bound_at_ms: 1_225,
            },
            runtime_workspace_id: rehosted_session.workspace_id.clone(),
            runner_principal: rehosted_session.runner_principal.clone(),
            runner_instance: rehosted_session.runner_instance.clone(),
            channel_epoch: rehosted_session.channel_epoch.clone(),
            host_instance_id: rehosted_session.host_instance_id.clone(),
            terminal_epoch: rehosted_session.terminal_epoch.clone(),
            updated_at_ms: 1_225,
        })
        .await
        .unwrap();
    let mut enrolled_successor_body = existing_session_run_body();
    enrolled_successor_body["session"] = serde_json::to_value(&rehosted_session).unwrap();
    enrolled_successor_body["integrationReceipt"]["version"] = json!("fixture-v3");
    enrolled_successor_body["idempotencyKey"] = json!("run-create-rehosted-session-successor");
    enrolled_successor_body["createdAtMs"] = json!(1_250);
    let enrolled_successor = invoke_orchestration(
        &state,
        "run-create-rehosted-session-successor",
        "run.create",
        enrolled_successor_body,
    )
    .await;
    let rebound = invoke_orchestration(
        &state,
        "run-rebind-completed-session-lineage",
        "dispatch.session.rebind",
        json!({
            "schemaVersion": 1,
            "operationId": "existing-session-rehost-1",
            "source": session,
            "target": rehosted_session,
            "reboundAtMs": 1_300,
        }),
    )
    .await;
    assert_eq!(rebound["receipt"]["outcome"], "rebound");
    assert_eq!(
        rebound["receipt"]["dispatchId"],
        enrolled_successor["receipt"]["context"]["target"]["dispatchId"]
    );

    let first_target: InteractionTarget =
        serde_json::from_value(first_context["target"].clone()).unwrap();
    let reopened_store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    assert_eq!(
        reopened_store
            .orchestration_target_for_exact_session(&rehosted_session)
            .await
            .unwrap(),
        first_target
    );
    reopened_store.close().await;

    let drainable = invoke_orchestration(
        &state,
        "run-context-drain-completed-session",
        "dispatch.context.get",
        json!({
            "schemaVersion": 1,
            "session": rehosted_session
        }),
    )
    .await;
    assert_eq!(drainable["receipt"]["target"], first_context["target"]);
    assert_eq!(
        drainable["receipt"]["coordinatorGrant"],
        first_context["coordinatorGrant"]
    );
    assert_eq!(drainable["receipt"]["dispatchRevision"], 2);
    let drainable_batch = invoke_orchestration(
        &state,
        "run-context-drain-completed-session-batch",
        "dispatch.context.get.batch",
        json!({ "schemaVersion": 1, "sessions": [rehosted_session] }),
    )
    .await;
    assert_eq!(
        drainable_batch["receipt"]["results"][0]["context"],
        drainable["receipt"]
    );
    let drained = invoke_orchestration(
        &state,
        "run-events-drain-completed-session",
        "events.read",
        json!({
            "schemaVersion": 1,
            "authority": first_context["target"]["authority"],
            "target": first_context["target"],
            "participant": first_context["coordinatorGrant"]["participant"],
            "deliveryCapability": first_context["coordinatorGrant"]["deliveryCapability"],
            "after": 0,
            "limit": 128
        }),
    )
    .await;
    assert!(
        drained["receipt"]["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|event| event["kind"]["kind"] == "dispatch_completed")
    );
    assert!(
        drained["receipt"]["deliveries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|delivery| delivery["state"] == "observed")
    );

    let current = invoke_orchestration(
        &state,
        "run-context-after-completed-session-drain",
        "dispatch.context.get",
        json!({
            "schemaVersion": 1,
            "session": rehosted_session
        }),
    )
    .await;
    assert_eq!(
        current["receipt"]["target"],
        enrolled_successor["receipt"]["context"]["target"]
    );
    assert_eq!(
        current["receipt"]["endpointFence"]["sessionIdentity"],
        drainable["receipt"]["endpointFence"]["sessionIdentity"]
    );
    assert_ne!(
        current["receipt"]["endpointFence"]["sessionIdentity"],
        successor["receipt"]["context"]["endpointFence"]["sessionIdentity"]
    );
    let current_batch = invoke_orchestration(
        &state,
        "run-context-after-completed-session-drain-batch",
        "dispatch.context.get.batch",
        json!({ "schemaVersion": 1, "sessions": [rehosted_session] }),
    )
    .await;
    assert_eq!(
        current_batch["receipt"]["results"][0]["context"],
        current["receipt"]
    );

    let stale_source = dispatch(
        &state,
        &orchestration_backend_request(
            &state,
            "run-create-completed-session-successor-stale-source",
            "run.create",
            successor_body,
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(stale_source.code, "orchestration_generation_conflict");
    let active = invoke_orchestration(
        &state,
        "run-inspect-successor-session",
        "dispatch.session.inspect",
        json!({
            "schemaVersion": 1,
            "session": rehosted_session
        }),
    )
    .await;
    assert_eq!(active["receipt"]["outcome"], "active_dispatch");
    assert_eq!(
        active["receipt"]["target"],
        enrolled_successor["receipt"]["context"]["target"]
    );
    let verification_pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new()
            .filename(root.path().join("domain.sqlite"))
            .read_only(true),
    )
    .await
    .unwrap();
    let run_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM workflow_runs WHERE contribution_id = 'workflow.existing-session-reporting'",
    )
    .fetch_one(&verification_pool)
    .await
    .unwrap();
    let completed_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM workflow_dispatches WHERE state = 'completed'")
            .fetch_one(&verification_pool)
            .await
            .unwrap();
    let active_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM workflow_dispatches WHERE state = 'starting'")
            .fetch_one(&verification_pool)
            .await
            .unwrap();
    let audit_event_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM workflow_interaction_events WHERE json_extract(event_json, '$.kind.kind') IN ('run_created', 'dispatch_completed')",
    )
    .fetch_one(&verification_pool)
    .await
    .unwrap();
    assert_eq!(
        (run_count, completed_count, active_count, audit_event_count),
        (3, 1, 2, 4)
    );
    verification_pool.close().await;
    assert!(launcher.requests().is_empty());
    assert!(prompt_deliverer.requests().is_empty());
}

#[tokio::test]
async fn observed_completed_dispatch_remains_available_for_successor_enrollment() {
    let (_root, state, _launcher, _prompt_deliverer) =
        fixture_with_delivery(Vec::new(), Vec::new()).await;
    let first = invoke_orchestration(
        &state,
        "run-create-observed-completed-session",
        "run.create",
        existing_session_run_body(),
    )
    .await;
    let first_context = first["receipt"]["context"].clone();
    invoke_orchestration(
        &state,
        "run-complete-observed-completed-session",
        "dispatch.complete",
        json!({
            "schemaVersion": 1,
            "idempotencyKey": "run-complete-observed-completed-session",
            "messageId": "completion-observed-completed-session",
            "target": first_context["target"],
            "expectedDispatchRevision": 1,
            "completedBy": first_context["participant"],
            "endpointFence": first_context["endpointFence"],
            "audience": { "grants": [first_context["coordinatorGrant"].clone()] },
            "completionCapability": first_context["completionCapability"],
            "title": "Reporting cycle complete",
            "resultMarkdown": "The reporting cycle is complete.",
            "completedAtMs": 1_100
        }),
    )
    .await;
    invoke_orchestration(
        &state,
        "run-events-observe-completed-session",
        "events.read",
        json!({
            "schemaVersion": 1,
            "authority": first_context["target"]["authority"],
            "target": first_context["target"],
            "participant": first_context["coordinatorGrant"]["participant"],
            "deliveryCapability": first_context["coordinatorGrant"]["deliveryCapability"],
            "after": 0,
            "limit": 128
        }),
    )
    .await;

    let completed = invoke_orchestration(
        &state,
        "run-context-observed-completed-session",
        "dispatch.context.get",
        json!({
            "schemaVersion": 1,
            "session": existing_session_run_body()["session"].clone()
        }),
    )
    .await;
    assert_eq!(completed["receipt"]["target"], first_context["target"]);
    assert_eq!(completed["receipt"]["dispatchState"], "completed");
    assert_eq!(completed["receipt"]["successorRequired"], true);
    let completed_batch = invoke_orchestration(
        &state,
        "run-context-observed-completed-session-batch",
        "dispatch.context.get.batch",
        json!({
            "schemaVersion": 1,
            "sessions": [existing_session_run_body()["session"].clone()]
        }),
    )
    .await;
    assert_eq!(
        completed_batch["receipt"]["results"][0]["context"],
        completed["receipt"]
    );

    let mut successor_body = existing_session_run_body();
    successor_body["idempotencyKey"] = json!("run-create-observed-completed-successor");
    successor_body["createdAtMs"] = json!(1_200);
    let successor = invoke_orchestration(
        &state,
        "run-create-observed-completed-successor",
        "run.create",
        successor_body.clone(),
    )
    .await;
    let replay = invoke_orchestration(
        &state,
        "run-create-observed-completed-successor-replay",
        "run.create",
        successor_body,
    )
    .await;
    assert_eq!(replay["receipt"]["idempotent"], true);
    assert_eq!(
        replay["receipt"]["context"],
        successor["receipt"]["context"]
    );

    let current = invoke_orchestration(
        &state,
        "run-context-observed-completed-successor",
        "dispatch.context.get",
        json!({
            "schemaVersion": 1,
            "session": existing_session_run_body()["session"].clone()
        }),
    )
    .await;
    assert_eq!(current["receipt"], successor["receipt"]["context"]);
    assert_eq!(current["receipt"]["dispatchState"], "active");
    assert_eq!(current["receipt"]["successorRequired"], false);
}

async fn prepare_exact_session_run(state: &ServiceState) -> (Value, Value) {
    let authority = state
        .store
        .agent_checkpoint_binding_authority(&AgentIdV1::new("coordinator-1").unwrap())
        .await
        .unwrap()
        .unwrap();
    state
        .store
        .converge_agent_checkpoint_provider_conversation(&authority, "coordinator-conversation")
        .await
        .unwrap();
    let run_body = existing_session_run_body();
    let created = invoke_orchestration(
        state,
        "assignment-create-existing-session",
        "run.create",
        run_body.clone(),
    )
    .await;
    let context = created["receipt"]["context"].clone();
    let preview = invoke_orchestration(
        state,
        "assignment-preview-existing-session",
        "dispatch.context.get.exact-session",
        json!({
            "schemaVersion": 1,
            "session": run_body["session"].clone()
        }),
    )
    .await;
    assert_eq!(preview["receipt"], context);
    (context, run_body["session"].clone())
}

async fn prepare_exact_session_message(state: &ServiceState) -> (Value, Value) {
    let (context, session) = prepare_exact_session_run(state).await;
    let body = json!({
        "schemaVersion": 1,
        "session": session,
        "expectedEndpointRef": context["endpointFence"]["endpointRef"].clone(),
        "idempotencyKey": "assignment-open-existing-session-1",
        "interactionId": "assignment-existing-session-1",
        "title": "Review the bounded change",
        "descriptionMarkdown": "Inspect the requested change and report through the durable inbox.",
        "openedAtMs": 1_100
    });
    (context, body)
}

#[tokio::test]
async fn empty_event_read_does_not_persist_unchanged_orchestration_state() {
    let (root, state, _launcher, _prompt_deliverer) = fixture(Vec::new()).await;
    let (context, _session) = prepare_exact_session_run(&state).await;
    let target = context["target"].clone();
    let read_body = json!({
        "schemaVersion": 1,
        "authority": target["authority"],
        "target": target,
        "participant": context["coordinatorGrant"]["participant"],
        "deliveryCapability": context["coordinatorGrant"]["deliveryCapability"],
        "after": 0,
        "limit": 10
    });
    let initial = invoke_orchestration(
        &state,
        "empty-event-read-initial",
        "events.read",
        read_body.clone(),
    )
    .await;
    assert_eq!(initial["receipt"]["events"].as_array().unwrap().len(), 1);
    let cursor = initial["receipt"]["nextCursor"].clone();

    let fault_pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(root.path().join("domain.sqlite")),
    )
    .await
    .unwrap();
    sqlx::query(
        r#"
        CREATE TRIGGER fail_event_read_authority_write
        BEFORE UPDATE ON workflow_interaction_authorities
        BEGIN
            SELECT RAISE(ABORT, 'fault-injected event read authority write');
        END
        "#,
    )
    .execute(&fault_pool)
    .await
    .unwrap();

    let replayed = invoke_orchestration(
        &state,
        "observed-event-read-replayed",
        "events.read",
        read_body.clone(),
    )
    .await;
    assert_eq!(replayed["receipt"]["events"].as_array().unwrap().len(), 1);
    assert_eq!(replayed["receipt"]["deliveries"][0]["state"], "observed");
    assert_eq!(replayed["receipt"]["nextCursor"], cursor);

    let mut repeated_body = read_body.clone();
    repeated_body["after"] = cursor.clone();
    let repeated = invoke_orchestration(
        &state,
        "empty-event-read-repeated",
        "events.read",
        repeated_body.clone(),
    )
    .await;
    assert!(repeated["receipt"]["events"].as_array().unwrap().is_empty());
    assert_eq!(repeated["receipt"]["nextCursor"], cursor);

    sqlx::query("DROP TRIGGER fail_event_read_authority_write")
        .execute(&fault_pool)
        .await
        .unwrap();
    invoke_orchestration(
        &state,
        "empty-event-read-open-message",
        "interaction.open",
        json!({
            "schemaVersion": 1,
            "idempotencyKey": "empty-event-read-open-message-1",
            "writeCapability": context["interactionCapability"],
            "expectedDispatchRevision": context["dispatchRevision"],
            "openedAtMs": 1_200,
            "interaction": {
                "kind": "message",
                "common": {
                    "id": "empty-event-read-message-1",
                    "target": context["target"],
                    "author": context["participant"],
                    "audience": { "grants": [context["coordinatorGrant"].clone()] },
                    "title": "A new durable update",
                    "descriptionMarkdown": "This update must make its delivery observable."
                },
                "purpose": "update"
            }
        }),
    )
    .await;
    sqlx::query(
        r#"
        CREATE TRIGGER fail_event_read_authority_write
        BEFORE UPDATE ON workflow_interaction_authorities
        BEGIN
            SELECT RAISE(ABORT, 'fault-injected event read authority write');
        END
        "#,
    )
    .execute(&fault_pool)
    .await
    .unwrap();

    let changed = dispatch(
        &state,
        &orchestration_backend_request(
            &state,
            "changed-event-read",
            "events.read",
            repeated_body.clone(),
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(changed.code, "orchestration_store_unavailable");

    sqlx::query("DROP TRIGGER fail_event_read_authority_write")
        .execute(&fault_pool)
        .await
        .unwrap();
    let delivered = invoke_orchestration(
        &state,
        "changed-event-read-retry",
        "events.read",
        repeated_body,
    )
    .await;
    assert_eq!(delivered["receipt"]["events"].as_array().unwrap().len(), 1);
    assert_eq!(delivered["receipt"]["deliveries"][0]["state"], "observed");
    fault_pool.close().await;
}

#[tokio::test]
async fn event_read_batch_persists_once_and_rolls_back_observation_and_acknowledgement_together() {
    let (root, state, _launcher, _prompt_deliverer) = fixture(Vec::new()).await;
    let (context, _session) = prepare_exact_session_run(&state).await;
    let target = context["target"].clone();
    let batch_body = json!({
        "schemaVersion": 1,
        "authority": target["authority"],
        "requests": [
            {
                "correlationId": "observe-run-created",
                "request": {
                    "schemaVersion": 1,
                    "authority": target["authority"],
                    "target": target,
                    "participant": context["coordinatorGrant"]["participant"],
                    "deliveryCapability": context["coordinatorGrant"]["deliveryCapability"],
                    "after": 0,
                    "limit": 10
                }
            },
            {
                "correlationId": "ack-run-created",
                "request": {
                    "schemaVersion": 1,
                    "authority": target["authority"],
                    "target": target,
                    "participant": context["coordinatorGrant"]["participant"],
                    "deliveryCapability": context["coordinatorGrant"]["deliveryCapability"],
                    "after": 1,
                    "acknowledgement": {
                        "through": 1,
                        "idempotencyKey": "ack-event-batch-rollback-1",
                        "acknowledgementCapability": context["coordinatorGrant"]["deliveryCapability"]
                    },
                    "limit": 10
                }
            }
        ]
    });
    let fault_pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(root.path().join("domain.sqlite")),
    )
    .await
    .unwrap();
    sqlx::query(
        r#"
        CREATE TRIGGER fail_event_read_batch_cursor_write
        BEFORE UPDATE ON workflow_interaction_cursors
        BEGIN
            SELECT RAISE(ABORT, 'fault-injected Event batch cursor write');
        END
        "#,
    )
    .execute(&fault_pool)
    .await
    .unwrap();

    let failed = dispatch(
        &state,
        &orchestration_backend_request(
            &state,
            "event-read-batch-failed-persist",
            "events.read.batch",
            batch_body.clone(),
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(failed.code, "orchestration_store_unavailable");

    let authority_key: String = sqlx::query_scalar(
        "SELECT authority_key FROM workflow_interaction_authorities WHERE dispatch_id = ?1",
    )
    .bind(target["dispatchId"].as_str().unwrap())
    .fetch_one(&fault_pool)
    .await
    .unwrap();
    let delivery_json: serde_json::Value = serde_json::from_str(
        &sqlx::query_scalar::<_, String>(
            "SELECT delivery_json FROM workflow_interaction_deliveries WHERE authority_key = ?1 AND event_cursor = 1",
        )
        .bind(&authority_key)
        .fetch_one(&fault_pool)
        .await
        .unwrap(),
    )
    .unwrap();
    assert_eq!(delivery_json["receipt"]["state"], "queued");
    let acknowledgement_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM workflow_interaction_acknowledgements WHERE authority_key = ?1",
    )
    .bind(&authority_key)
    .fetch_one(&fault_pool)
    .await
    .unwrap();
    assert_eq!(acknowledgement_count, 0);

    sqlx::query("DROP TRIGGER fail_event_read_batch_cursor_write")
        .execute(&fault_pool)
        .await
        .unwrap();
    sqlx::query("CREATE TABLE event_read_batch_write_count (count INTEGER NOT NULL)")
        .execute(&fault_pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO event_read_batch_write_count (count) VALUES (0)")
        .execute(&fault_pool)
        .await
        .unwrap();
    sqlx::query(
        r#"
        CREATE TRIGGER count_event_read_batch_authority_write
        AFTER UPDATE ON workflow_interaction_authorities
        BEGIN
            UPDATE event_read_batch_write_count SET count = count + 1;
        END
        "#,
    )
    .execute(&fault_pool)
    .await
    .unwrap();

    let committed = invoke_orchestration(
        &state,
        "event-read-batch-committed",
        "events.read.batch",
        batch_body.clone(),
    )
    .await;
    assert_eq!(
        committed["receipt"]["results"][0]["receipt"]["deliveries"][0]["state"],
        "observed"
    );
    assert_eq!(
        committed["receipt"]["results"][1]["receipt"]["acknowledgement"]["delivery"]["state"],
        "acknowledged"
    );
    assert_eq!(
        committed["receipt"]["results"][1]["receipt"]["acknowledgement"]["idempotent"],
        false
    );
    let write_count: i64 = sqlx::query_scalar("SELECT count FROM event_read_batch_write_count")
        .fetch_one(&fault_pool)
        .await
        .unwrap();
    assert_eq!(write_count, 1);

    let replayed = invoke_orchestration(
        &state,
        "event-read-batch-replayed",
        "events.read.batch",
        batch_body,
    )
    .await;
    assert_eq!(
        replayed["receipt"]["results"][1]["receipt"]["acknowledgement"]["idempotent"],
        true
    );
    let replay_write_count: i64 =
        sqlx::query_scalar("SELECT count FROM event_read_batch_write_count")
            .fetch_one(&fault_pool)
            .await
            .unwrap();
    assert_eq!(replay_write_count, 1);
    fault_pool.close().await;
}

#[tokio::test]
async fn exact_session_decision_answer_derives_authority_after_validating_opaque_fences() {
    let (_root, state, _launcher, prompt_deliverer) = fixture(vec![LaunchOutcome::Succeed]).await;
    let (context, session) = prepare_exact_session_run(&state).await;
    let target = context["target"].clone();
    let opened = invoke_orchestration(
        &state,
        "exact-decision-open",
        "interaction.open",
        json!({
            "schemaVersion": 1,
            "idempotencyKey": "exact-decision-open-1",
            "writeCapability": context["interactionCapability"],
            "expectedDispatchRevision": context["dispatchRevision"],
            "openedAtMs": 1_200,
            "interaction": {
                "kind": "decision",
                "common": {
                    "id": "exact-decision-1",
                    "target": target,
                    "author": context["participant"],
                    "audience": { "grants": [context["coordinatorGrant"].clone()] },
                    "title": "Choose the deployment scope",
                    "descriptionMarkdown": "Select one scope for this generation."
                },
                "response": {
                    "kind": "select",
                    "options": [
                        { "id": "local", "label": "Local" },
                        { "id": "remote", "label": "Remote" }
                    ],
                    "minSelections": 1,
                    "maxSelections": 1
                },
                "replyCapability": context["coordinatorReplyCapability"]
            }
        }),
    )
    .await;
    assert_eq!(opened["receipt"]["dispatchState"], "blocked");

    let answer_body = json!({
        "schemaVersion": 1,
        "session": session,
        "expectedDispatchRevision": 2,
        "expectedReplyCapability": context["coordinatorReplyCapability"],
        "idempotencyKey": "exact-decision-answer-1",
        "interactionId": "exact-decision-1",
        "expectedRevision": 1,
        "answer": { "kind": "select", "optionIds": ["local"] },
        "answeredAtMs": 1_300
    });
    let mut stale_capability = answer_body.clone();
    stale_capability["expectedReplyCapability"] = json!("capability-stale-reply");
    stale_capability["idempotencyKey"] = json!("exact-decision-stale-capability");
    let stale_capability_error = dispatch(
        &state,
        &orchestration_backend_request(
            &state,
            "exact-decision-stale-capability",
            "interaction.decision.answer.exact-session",
            stale_capability,
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(
        stale_capability_error.code,
        "orchestration_generation_conflict"
    );
    assert_eq!(
        stale_capability_error.disposition,
        BackendFailureDispositionV1::StaleGeneration
    );

    let mut stale_dispatch_revision = answer_body.clone();
    stale_dispatch_revision["expectedDispatchRevision"] = json!(1);
    stale_dispatch_revision["idempotencyKey"] = json!("exact-decision-stale-dispatch");
    let stale_dispatch_error = dispatch(
        &state,
        &orchestration_backend_request(
            &state,
            "exact-decision-stale-dispatch",
            "interaction.decision.answer.exact-session",
            stale_dispatch_revision,
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(stale_dispatch_error.code, "orchestration_revision_conflict");
    assert_eq!(
        stale_dispatch_error.disposition,
        BackendFailureDispositionV1::StaleGeneration
    );

    let mut stale_session = answer_body.clone();
    stale_session["session"]["terminalEpoch"] = json!("terminal-stale");
    stale_session["idempotencyKey"] = json!("exact-decision-stale-session");
    let stale_session_error = dispatch(
        &state,
        &orchestration_backend_request(
            &state,
            "exact-decision-stale-session",
            "interaction.decision.answer.exact-session",
            stale_session,
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(
        stale_session_error.code,
        "orchestration_generation_conflict"
    );
    assert_eq!(
        stale_session_error.disposition,
        BackendFailureDispositionV1::StaleGeneration
    );

    let still_open = invoke_orchestration(
        &state,
        "exact-decision-read-after-stale-answers",
        "interaction.get",
        json!({
            "schemaVersion": 1,
            "authority": target["authority"],
            "interactionId": "exact-decision-1",
            "participant": context["coordinatorGrant"]["participant"],
            "readCapability": context["coordinatorGrant"]["deliveryCapability"]
        }),
    )
    .await;
    assert_eq!(still_open["receipt"]["state"]["state"], "open");
    assert_eq!(still_open["receipt"]["common"]["revision"], 1);

    let answered = invoke_orchestration(
        &state,
        "exact-decision-answer",
        "interaction.decision.answer.exact-session",
        answer_body.clone(),
    )
    .await;
    assert_eq!(answered["receipt"]["dispatchState"], "active");
    let worker_delivery = answered["receipt"]["deliveries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|delivery| {
            delivery["endpoint"]["sessionIdentity"] == context["endpointFence"]["sessionIdentity"]
        })
        .unwrap();
    assert_eq!(worker_delivery["wake"]["state"], "triggered");
    let wake_requests = prompt_deliverer.requests();
    assert_eq!(wake_requests.len(), 1);
    assert_eq!(
        wake_requests[0].handoff,
        "A Dure inbox event is waiting. Read and acknowledge it with the installed dure-orchestration tools."
    );
    let exact_replay = invoke_orchestration(
        &state,
        "exact-decision-answer-replay",
        "interaction.decision.answer.exact-session",
        answer_body,
    )
    .await;
    assert_eq!(exact_replay["receipt"]["idempotent"], true);
    assert!(
        exact_replay["receipt"]["deliveries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|delivery| delivery["wake"]["state"] == "triggered")
    );
    assert_eq!(prompt_deliverer.requests().len(), 1);

    let generic_replay = invoke_orchestration(
        &state,
        "exact-decision-generic-replay",
        "interaction.answer",
        json!({
            "schemaVersion": 1,
            "idempotencyKey": "exact-decision-answer-1",
            "interactionId": "exact-decision-1",
            "target": target,
            "expectedRevision": 1,
            "expectedDispatchRevision": 2,
            "answeredBy": context["coordinatorGrant"]["participant"],
            "replyCapability": context["coordinatorReplyCapability"],
            "answer": { "kind": "select", "optionIds": ["local"] },
            "answeredAtMs": 1_300
        }),
    )
    .await;
    assert_eq!(generic_replay["receipt"]["idempotent"], true);
}

#[tokio::test]
async fn exact_existing_session_persists_then_wakes_once_without_replaying_message_content() {
    let (root, state, launcher, prompt_deliverer) =
        fixture_with_delivery(Vec::new(), vec![DeliveryOutcome::Succeed]).await;
    let (created_context, body) = prepare_exact_session_message(&state).await;
    let legacy_pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(root.path().join("domain.sqlite")),
    )
    .await
    .unwrap();
    sqlx::query(
        "UPDATE workflow_interaction_authorities SET worker_endpoint_json = json_remove(worker_endpoint_json, '$.wakeCapability')",
    )
    .execute(&legacy_pool)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE workflow_interaction_deliveries SET delivery_json = json_remove(delivery_json, '$.wake_capability')",
    )
    .execute(&legacy_pool)
    .await
    .unwrap();
    legacy_pool.close().await;
    let restored = invoke_orchestration(
        &state,
        "assignment-preview-legacy-existing-session",
        "dispatch.context.get.exact-session",
        json!({
            "schemaVersion": 1,
            "session": existing_session_run_body()["session"].clone()
        }),
    )
    .await;
    let context = restored["receipt"].clone();
    assert!(context["wakeCapability"].as_str().is_some());
    assert_ne!(context["wakeCapability"], created_context["wakeCapability"]);
    let opened = invoke_orchestration(
        &state,
        "assignment-open-existing-session",
        "interaction.message.open.exact-session",
        body.clone(),
    )
    .await;
    assert_eq!(opened["receipt"]["interaction"]["kind"], "message");
    assert_eq!(opened["receipt"]["interaction"]["purpose"], "update");
    assert_eq!(opened["receipt"]["idempotent"], false);
    assert_eq!(opened["receipt"]["deliveries"].as_array().unwrap().len(), 1);
    assert_eq!(
        opened["receipt"]["deliveries"][0]["endpoint"]["sessionIdentity"],
        context["endpointFence"]["sessionIdentity"]
    );
    assert_eq!(
        opened["receipt"]["deliveries"][0]["wake"]["state"],
        "triggered"
    );
    assert_eq!(launcher.requests().len(), 0);
    let wake_requests = prompt_deliverer.requests();
    assert_eq!(wake_requests.len(), 1);
    assert_eq!(
        wake_requests[0].intent,
        WorkflowPromptDeliveryIntentV1::ExistingConversation {
            provider_conversation_id: "coordinator-conversation".into(),
        }
    );
    assert_eq!(
        wake_requests[0].handoff,
        "A Dure inbox event is waiting. Read and acknowledge it with the installed dure-orchestration tools."
    );
    assert!(
        !wake_requests[0]
            .handoff
            .contains("Inspect the requested change")
    );

    let replay = invoke_orchestration(
        &state,
        "assignment-open-existing-session-replay",
        "interaction.message.open.exact-session",
        body.clone(),
    )
    .await;
    assert_eq!(
        replay["receipt"]["interaction"],
        opened["receipt"]["interaction"]
    );
    assert_eq!(replay["receipt"]["idempotent"], true);
    assert_eq!(prompt_deliverer.requests().len(), 1);

    let persisted_context: DispatchContextReceipt =
        serde_json::from_value(context.clone()).unwrap();
    let reopened_store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    let persisted_wake = reopened_store
        .interaction_service()
        .transition_delivery_wake(
            agent_orchestration::contract::TransitionDeliveryWakeRequest {
                schema_version: agent_orchestration::domain::INTERACTION_SCHEMA_VERSION,
                authority: persisted_context.target.authority,
                receipt_id: serde_json::from_value(
                    opened["receipt"]["deliveries"][0]["receiptId"].clone(),
                )
                .unwrap(),
                endpoint_fence: persisted_context.endpoint_fence,
                wake_capability: persisted_context.wake_capability,
                transition: agent_orchestration::contract::DeliveryWakeTransition::Request,
                transitioned_at_ms: 1_101,
            },
        )
        .await
        .unwrap();
    assert!(!persisted_wake.applied);
    assert_eq!(
        persisted_wake.delivery.wake.unwrap().state,
        agent_orchestration::contract::DeliveryWakeState::Triggered
    );
    reopened_store.close().await;

    let mut stale_endpoint = body.clone();
    stale_endpoint["expectedEndpointRef"] = json!("endpoint-stale-assignment");
    stale_endpoint["idempotencyKey"] = json!("assignment-open-stale-endpoint");
    stale_endpoint["interactionId"] = json!("assignment-stale-endpoint");
    let endpoint_error = dispatch(
        &state,
        &orchestration_backend_request(
            &state,
            "assignment-open-stale-endpoint",
            "interaction.message.open.exact-session",
            stale_endpoint,
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(endpoint_error.code, "orchestration_generation_conflict");
    assert_eq!(
        endpoint_error.disposition,
        BackendFailureDispositionV1::Terminal
    );

    let mut replacement = body;
    replacement["session"]["terminalEpoch"] = json!("replacement-terminal");
    replacement["idempotencyKey"] = json!("assignment-open-replacement");
    replacement["interactionId"] = json!("assignment-replacement");
    let generation_error = dispatch(
        &state,
        &orchestration_backend_request(
            &state,
            "assignment-open-replacement",
            "interaction.message.open.exact-session",
            replacement,
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(generation_error.code, "orchestration_generation_conflict");
    assert_eq!(
        generation_error.disposition,
        BackendFailureDispositionV1::Terminal
    );
}

#[tokio::test]
async fn completed_exact_session_receives_updates_without_reopening_its_dispatch() {
    let (root, state, launcher, prompt_deliverer) = fixture_with_delivery(
        Vec::new(),
        vec![DeliveryOutcome::Fail(
            "workflow_prompt_provider_busy",
            false,
        )],
    )
    .await;
    let (context, mut body) = prepare_exact_session_message(&state).await;
    let session = body["session"].clone();
    let completed = invoke_orchestration(
        &state,
        "complete-before-handoff",
        "dispatch.complete",
        json!({
            "schemaVersion": 1,
            "idempotencyKey": "complete-before-handoff",
            "messageId": "completion-before-handoff",
            "target": context["target"],
            "expectedDispatchRevision": context["dispatchRevision"],
            "completedBy": context["participant"],
            "endpointFence": context["endpointFence"],
            "audience": { "grants": [context["coordinatorGrant"]] },
            "completionCapability": context["completionCapability"],
            "title": "Previous work completed",
            "resultMarkdown": "Preserve this result.",
            "completedAtMs": 1_100
        }),
    )
    .await;
    body["openedAtMs"] = json!(1_200);
    let opened = invoke_orchestration(
        &state,
        "handoff-after-completion",
        "interaction.message.open.exact-session",
        body.clone(),
    )
    .await;
    assert_eq!(opened["receipt"]["dispatchState"], "completed");
    assert_eq!(opened["receipt"]["interaction"]["purpose"], "update");
    assert_eq!(
        opened["receipt"]["deliveries"][0]["wake"]["state"],
        "queued_until_next_turn"
    );
    let replay = invoke_orchestration(
        &state,
        "handoff-after-completion-replay",
        "interaction.message.open.exact-session",
        body.clone(),
    )
    .await;
    assert_eq!(replay["receipt"]["idempotent"], true);
    assert_eq!(
        replay["receipt"]["interaction"],
        opened["receipt"]["interaction"]
    );
    assert_eq!(prompt_deliverer.requests().len(), 1);
    assert!(launcher.requests().is_empty());

    let mut successor_body = existing_session_run_body();
    successor_body["idempotencyKey"] = json!("reporting-successor-after-handoff");
    successor_body["createdAtMs"] = json!(1_300);
    let successor = invoke_orchestration(
        &state,
        "reporting-successor-after-handoff",
        "run.create",
        successor_body,
    )
    .await;
    invoke_orchestration(
        &state,
        "observe-prior-coordinator-completion",
        "events.read",
        json!({
            "schemaVersion": 1,
            "authority": context["target"]["authority"],
            "target": context["target"],
            "participant": context["coordinatorGrant"]["participant"],
            "deliveryCapability": context["coordinatorGrant"]["deliveryCapability"],
            "after": 0,
            "limit": 128
        }),
    )
    .await;
    let pending = invoke_orchestration(
        &state,
        "context-with-pending-worker-handoff",
        "dispatch.context.get.exact-session",
        json!({ "schemaVersion": 1, "session": session }),
    )
    .await;
    assert_eq!(pending["receipt"]["target"], context["target"]);
    assert_eq!(pending["receipt"]["dispatchRevision"], 2);
    assert_eq!(pending["receipt"]["dispatchState"], "completed");
    assert_eq!(pending["receipt"]["successorRequired"], false);
    let batch = invoke_orchestration(
        &state,
        "batch-context-with-pending-worker-handoff",
        "dispatch.context.get.batch",
        json!({ "schemaVersion": 1, "sessions": [session] }),
    )
    .await;
    assert_eq!(
        batch["receipt"]["results"][0]["context"],
        pending["receipt"]
    );
    let completion_message = invoke_orchestration(
        &state,
        "read-preserved-completion-after-handoff",
        "interaction.get",
        json!({
            "schemaVersion": 1,
            "authority": context["target"]["authority"],
            "interactionId": "completion-before-handoff",
            "participant": context["coordinatorGrant"]["participant"],
            "readCapability": context["coordinatorGrant"]["deliveryCapability"]
        }),
    )
    .await;
    assert_eq!(
        completion_message["receipt"],
        completed["receipt"]["message"]
    );

    let fixture_pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(root.path().join("domain.sqlite")),
    )
    .await
    .unwrap();
    let message_cursor = opened["receipt"]["events"][0]["cursor"].as_i64().unwrap();
    let event_json: String =
        sqlx::query_scalar("SELECT event_json FROM workflow_interaction_events WHERE cursor = ?1")
            .bind(message_cursor)
            .fetch_one(&fixture_pool)
            .await
            .unwrap();
    sqlx::query(
        "UPDATE workflow_interaction_events SET event_json = 'invalid-json' WHERE cursor = ?1",
    )
    .bind(message_cursor)
    .execute(&fixture_pool)
    .await
    .unwrap();
    let corrupt = invoke_orchestration(
        &state,
        "batch-context-with-corrupt-worker-handoff",
        "dispatch.context.get.batch",
        json!({ "schemaVersion": 1, "sessions": [session] }),
    )
    .await;
    sqlx::query("UPDATE workflow_interaction_events SET event_json = ?1 WHERE cursor = ?2")
        .bind(event_json)
        .bind(message_cursor)
        .execute(&fixture_pool)
        .await
        .unwrap();
    fixture_pool.close().await;
    assert_eq!(corrupt["receipt"]["results"][0]["outcome"], "failed");

    let reopened = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    assert_eq!(
        reopened
            .orchestration_target_for_exact_session(
                &serde_json::from_value(session.clone()).unwrap()
            )
            .await
            .unwrap(),
        serde_json::from_value(context["target"].clone()).unwrap()
    );
    reopened.close().await;
    let read = invoke_orchestration(
        &state,
        "read-worker-handoff-after-completion",
        "events.read",
        json!({
            "schemaVersion": 1,
            "authority": context["target"]["authority"],
            "target": context["target"],
            "participant": context["participant"],
            "deliveryCapability": context["deliveryCapability"],
            "endpointFence": context["endpointFence"],
            "after": 0,
            "limit": 128
        }),
    )
    .await;
    assert!(
        read["receipt"]["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|event| { event["kind"]["interactionId"] == body["interactionId"] })
    );
    let message = invoke_orchestration(
        &state,
        "get-worker-handoff-after-completion",
        "interaction.get",
        json!({
            "schemaVersion": 1,
            "authority": context["target"]["authority"],
            "interactionId": body["interactionId"],
            "participant": context["participant"],
            "readCapability": context["deliveryCapability"],
            "endpointFence": context["endpointFence"]
        }),
    )
    .await;
    assert_eq!(message["receipt"], opened["receipt"]["interaction"]);
    let current = invoke_orchestration(
        &state,
        "context-after-worker-handoff-read",
        "dispatch.context.get.exact-session",
        json!({ "schemaVersion": 1, "session": session }),
    )
    .await;
    assert_eq!(
        current["receipt"]["target"],
        successor["receipt"]["context"]["target"]
    );
}

#[tokio::test]
async fn uncertain_exact_session_wake_is_never_replayed() {
    let (_root, state, _launcher, prompt_deliverer) = fixture_with_delivery(
        Vec::new(),
        vec![DeliveryOutcome::Fail("hmux_input_receipt_timeout", true)],
    )
    .await;
    let (_context, body) = prepare_exact_session_message(&state).await;
    let opened = invoke_orchestration(
        &state,
        "assignment-open-existing-session",
        "interaction.message.open.exact-session",
        body.clone(),
    )
    .await;
    assert_eq!(
        opened["receipt"]["deliveries"][0]["wake"]["state"],
        "uncertain"
    );
    assert_eq!(prompt_deliverer.requests().len(), 1);

    let replay = invoke_orchestration(
        &state,
        "assignment-open-existing-session-replay",
        "interaction.message.open.exact-session",
        body,
    )
    .await;
    assert_eq!(
        replay["receipt"]["deliveries"][0]["wake"]["state"],
        "uncertain"
    );
    assert_eq!(prompt_deliverer.requests().len(), 1);
}

#[tokio::test]
async fn busy_exact_session_keeps_the_durable_message_queued_without_input() {
    let (_root, state, _launcher, prompt_deliverer) = fixture_with_delivery(
        Vec::new(),
        vec![DeliveryOutcome::Fail(
            "workflow_prompt_provider_busy",
            false,
        )],
    )
    .await;
    let (_context, body) = prepare_exact_session_message(&state).await;
    let opened = invoke_orchestration(
        &state,
        "assignment-open-existing-session",
        "interaction.message.open.exact-session",
        body,
    )
    .await;
    let wake = &opened["receipt"]["deliveries"][0]["wake"];
    assert_eq!(wake["state"], "queued_until_next_turn");
    assert_eq!(wake["reasonCode"], "workflow_prompt_provider_busy");
    assert_eq!(opened["receipt"]["interaction"]["kind"], "message");
    assert_eq!(prompt_deliverer.requests().len(), 1);
}

#[tokio::test]
async fn production_sqlite_orchestration_store_conforms_to_the_human_decision_loop_without_pty_delivery()
 {
    let (root, state, _launcher, prompt_deliverer) = fixture(vec![LaunchOutcome::Succeed]).await;
    let active = receipt(&delegate_once(&state, request()).await.unwrap());
    assert_eq!(prompt_deliverer.requests().len(), 1);
    let target = json!({
        "authority": { "workspaceId": "workspace-1" },
        "runId": active.run_id,
        "taskId": active.task_id,
        "dispatchId": active.dispatch_id,
        "generation": active.generation,
    });
    let worker_context = bind_fixture_worker_context(&state, &active).await;
    let context = &worker_context["receipt"];
    assert_eq!(worker_context["apiVersion"], "dure.orchestration/v1");
    assert_eq!(worker_context["method"], "dispatch.context");
    assert_eq!(context["dispatchRevision"], 1);

    let desktop_context = invoke_orchestration(
        &state,
        "orchestration-context-desktop-read",
        "dispatch.context.get",
        json!({
            "schemaVersion": 1,
            "session": active.session.clone(),
        }),
    )
    .await;
    assert_eq!(desktop_context["schemaVersion"], 1);
    assert_eq!(desktop_context["receipt"], worker_context["receipt"]);

    let decision = invoke_orchestration(
        &state,
        "orchestration-open-decision",
        "interaction.open",
        json!({
            "schemaVersion": 1,
            "idempotencyKey": "open-decision-control-plane-1",
            "writeCapability": context["interactionCapability"],
            "expectedDispatchRevision": context["dispatchRevision"],
            "openedAtMs": 1_200,
            "interaction": {
                "kind": "decision",
                "common": {
                    "id": "decision-control-plane-1",
                    "target": target,
                    "author": context["participant"],
                    "audience": { "grants": [context["coordinatorGrant"].clone()] },
                    "title": "배포 범위를 선택하세요",
                    "descriptionMarkdown": "현재 세대에 적용할 **범위**를 선택하세요."
                },
                "response": {
                    "kind": "select",
                    "options": [
                        { "id": "local", "label": "로컬" },
                        { "id": "remote", "label": "원격" }
                    ],
                    "minSelections": 1,
                    "maxSelections": 1
                },
                "replyCapability": context["coordinatorReplyCapability"]
            }
        }),
    )
    .await;
    assert_eq!(decision["receipt"]["dispatchState"], "blocked");
    assert_eq!(decision["receipt"]["events"].as_array().unwrap().len(), 2);
    let blocked_scalar = invoke_orchestration(
        &state,
        "orchestration-context-blocked-scalar",
        "dispatch.context.get",
        json!({
            "schemaVersion": 1,
            "session": active.session.clone(),
        }),
    )
    .await;
    let blocked_batch = invoke_orchestration(
        &state,
        "orchestration-context-blocked-batch",
        "dispatch.context.get.batch",
        json!({
            "schemaVersion": 1,
            "sessions": [active.session.clone()],
        }),
    )
    .await;
    assert_eq!(blocked_scalar["receipt"]["dispatchState"], "blocked");
    assert_eq!(
        blocked_batch["receipt"]["results"][0]["context"],
        blocked_scalar["receipt"]
    );

    let reopened_store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    let persisted = reopened_store
        .interaction_service()
        .get(
            serde_json::from_value(json!({
                "schemaVersion": 1,
                "authority": target["authority"],
                "interactionId": "decision-control-plane-1",
                "participant": context["coordinatorGrant"]["participant"],
                "readCapability": context["coordinatorGrant"]["deliveryCapability"]
            }))
            .unwrap(),
        )
        .await
        .unwrap();
    assert!(matches!(
        persisted,
        InteractionRecord::Decision {
            state: DecisionState::Open,
            ..
        }
    ));
    reopened_store.close().await;

    let human_delivery = invoke_orchestration(
        &state,
        "orchestration-read-human",
        "events.read",
        json!({
            "schemaVersion": 1,
            "authority": target["authority"],
            "target": target,
            "participant": context["coordinatorGrant"]["participant"],
            "deliveryCapability": context["coordinatorGrant"]["deliveryCapability"],
            "after": 0,
            "limit": 10
        }),
    )
    .await;
    assert_eq!(
        human_delivery["receipt"]["events"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let answer_body = json!({
        "schemaVersion": 1,
        "idempotencyKey": "answer-decision-control-plane-1",
        "interactionId": "decision-control-plane-1",
        "target": target,
        "expectedRevision": 1,
        "expectedDispatchRevision": 2,
        "answeredBy": context["coordinatorGrant"]["participant"],
        "replyCapability": context["coordinatorReplyCapability"],
        "answer": { "kind": "select", "optionIds": ["local"] },
        "answeredAtMs": 1_300
    });
    let answered = invoke_orchestration(
        &state,
        "orchestration-answer-decision",
        "interaction.answer",
        answer_body.clone(),
    )
    .await;
    assert_eq!(answered["receipt"]["dispatchState"], "active");
    let answer_replay = invoke_orchestration(
        &state,
        "orchestration-answer-decision-replay",
        "interaction.answer",
        answer_body,
    )
    .await;
    assert_eq!(answer_replay["receipt"]["idempotent"], true);

    let worker_read_body = json!({
        "schemaVersion": 1,
        "authority": target["authority"],
        "target": target,
        "participant": context["participant"],
        "deliveryCapability": context["deliveryCapability"],
        "endpointFence": context["endpointFence"],
        "after": 0,
        "limit": 10
    });
    let mut stale_worker_read = worker_read_body.clone();
    stale_worker_read["endpointFence"]["generation"] = json!(active.generation + 1);
    let stale_error = dispatch(
        &state,
        &orchestration_backend_request(
            &state,
            "orchestration-read-worker-stale",
            "events.read",
            stale_worker_read,
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(stale_error.code, "orchestration_capability_denied");

    let first_worker_delivery = invoke_orchestration(
        &state,
        "orchestration-read-worker-first",
        "events.read",
        worker_read_body.clone(),
    )
    .await;
    let retried_worker_delivery = invoke_orchestration(
        &state,
        "orchestration-read-worker-retry",
        "events.read",
        worker_read_body,
    )
    .await;
    assert_eq!(
        retried_worker_delivery["receipt"],
        first_worker_delivery["receipt"]
    );
    let cursor = first_worker_delivery["receipt"]["nextCursor"].clone();
    let delivery_receipt = first_worker_delivery["receipt"]["deliveries"][0]["receiptId"].clone();
    let acknowledged = invoke_orchestration(
        &state,
        "orchestration-ack-worker",
        "events.read",
        json!({
            "schemaVersion": 1,
            "authority": target["authority"],
            "target": target,
            "participant": context["participant"],
            "deliveryCapability": context["deliveryCapability"],
            "endpointFence": context["endpointFence"],
            "after": cursor,
            "acknowledgement": {
                "through": cursor,
                "idempotencyKey": "ack-worker-control-plane-1",
                "acknowledgementCapability": context["acknowledgementCapability"]
            },
            "limit": 10
        }),
    )
    .await;
    assert!(
        acknowledged["receipt"]["events"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        acknowledged["receipt"]["acknowledgement"]["delivery"]["receiptId"],
        delivery_receipt
    );
    assert_eq!(
        acknowledged["receipt"]["acknowledgement"]["delivery"]["state"],
        "acknowledged"
    );
    assert_eq!(
        first_worker_delivery["receipt"]["deliveries"][0]["receiptId"],
        delivery_receipt
    );

    let completion_body = json!({
        "schemaVersion": 1,
        "idempotencyKey": "complete-control-plane-1",
        "messageId": "completion-control-plane-1",
        "target": target,
        "expectedDispatchRevision": 3,
        "completedBy": context["participant"],
        "endpointFence": context["endpointFence"],
        "audience": { "grants": [context["coordinatorGrant"].clone()] },
        "completionCapability": context["completionCapability"],
        "title": "검토 완료",
        "resultMarkdown": "선택된 범위는 **로컬**입니다.",
        "completedAtMs": 1_400
    });
    let fault_pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(root.path().join("domain.sqlite")),
    )
    .await;
    let fault_pool = fault_pool.unwrap();
    sqlx::query(
        r#"
        CREATE TRIGGER fail_orchestration_completion_event
        BEFORE INSERT ON workflow_interaction_events
        WHEN json_extract(NEW.event_json, '$.kind.kind') = 'dispatch_completed'
        BEGIN
            SELECT RAISE(ABORT, 'fault-injected completion Event');
        END
        "#,
    )
    .execute(&fault_pool)
    .await
    .unwrap();
    let completion_error = dispatch(
        &state,
        &orchestration_backend_request(
            &state,
            "orchestration-complete-worker-fault",
            "dispatch.complete",
            completion_body.clone(),
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(completion_error.code, "orchestration_store_unavailable");
    let still_active = state
        .store
        .delegate_once_receipt_for_dispatch(&active.task_id, &active.dispatch_id, active.generation)
        .await
        .unwrap();
    assert_eq!(still_active.status, WorkflowDispatchStateV1::Active);
    sqlx::query("DROP TRIGGER fail_orchestration_completion_event")
        .execute(&fault_pool)
        .await
        .unwrap();
    fault_pool.close().await;

    let completion = invoke_orchestration(
        &state,
        "orchestration-complete-worker",
        "dispatch.complete",
        completion_body,
    )
    .await;
    assert_eq!(completion["receipt"]["dispatchState"], "completed");
    assert_eq!(completion["receipt"]["events"].as_array().unwrap().len(), 1);
    let canonical = state
        .store
        .delegate_once_receipt_for_dispatch(&active.task_id, &active.dispatch_id, active.generation)
        .await
        .unwrap();
    assert_eq!(canonical.status, WorkflowDispatchStateV1::Completed);
    assert_eq!(
        canonical.result.as_deref(),
        Some("선택된 범위는 **로컬**입니다.")
    );
    assert_eq!(prompt_deliverer.requests().len(), 1);
}
