//! Tauri-independent application contracts.
//!
//! This crate deliberately contains no concrete providers, runtimes, workspace
//! tools, file viewers, or Tauri imports. Wire DTOs are versioned separately
//! from behavior traits so they can be reused by a future out-of-process host.

mod agent_bootstrap;
mod agent_dispatch_stop;
mod agent_goal;
mod agent_queue;
mod agent_integration;
mod agent_plugin_cli;
mod agent_plugin_cli_invocation;
mod agent_plugin_cli_plan;
mod agent_provider_registry;
mod agent_runtime_close;
mod agent_runtime_rehost;
mod agent_runtime_transition;
mod agent_spawn;
mod agent_timeline;
mod backend_observation;
mod browser_profile;
mod client_view_state;
mod codegen;
mod compatibility;
mod contract;
mod domain_store;
mod issue_tracker;
mod issue_tracker_v2;
mod plugin_apply_compensation;
mod plugin_apply_execution;
mod plugin_apply_journal;
mod plugin_apply_start;
mod plugin_contract;
mod plugin_native_ownership;
mod plugin_native_state;
mod plugin_native_target_binding;
mod plugin_native_transition;
mod plugin_package_registry;
mod plugin_permission;
mod plugin_permission_state;
mod plugin_registry;
mod plugin_settings;
mod plugin_views;
mod plugin_workflows;
mod provider_credential_profile;
mod provider_execution;
mod provider_launch_defaults;
mod provider_runtime_integration;
mod registry;
mod runtime_adapter_registry;
mod schedule;
mod session_checkout;
mod workflow;

pub use agent_bootstrap::{
    AgentBootstrapV1, agent_bootstrap_project_id, agent_bootstrap_runtime_workspace,
    agent_bootstrap_workspace_id,
};
pub use agent_dispatch_stop::*;
pub use agent_goal::*;
pub use agent_queue::*;
pub use agent_integration::{
    AgentEnvironmentTargetV2, AgentIntegrationEffectOwnershipV2, AgentIntegrationEffectReceiptV2,
    AgentIntegrationInstallActionV2, AgentIntegrationInstallPlanV2,
    AgentIntegrationInstallReceiptV2, AgentIntegrationPlanErrorV2,
    AgentIntegrationUninstallActionV2, AgentIntegrationUninstallPlanV2,
    plan_agent_integration_install, plan_agent_integration_uninstall,
};
pub use agent_plugin_cli::{
    AgentNativePluginCliCapabilityV2, AgentNativePluginCliCommandV2, AgentNativePluginCliOutputV2,
    AgentNativePluginCliPlanRequestV2, AgentNativePluginCliPlanV2, AgentNativePluginCliProbeV2,
    AgentNativePluginExecutableV2, AgentNativePluginMarketplaceSourceV2,
    AgentNativePluginRegistrationTargetV2,
};
pub use agent_plugin_cli_invocation::{
    AgentNativePluginCliArgumentV2, AgentNativePluginCliEnvironmentV2,
    AgentNativePluginCliInvocationErrorV2, AgentNativePluginCliInvocationV2,
    AgentNativePluginCliWorkingDirectoryV2, compile_agent_native_plugin_cli_invocation,
};
pub use agent_plugin_cli_plan::{AgentNativePluginCliPlanErrorV2, plan_agent_native_plugin_cli};
pub use agent_provider_registry::{
    AgentProviderImplementation, AgentProviderLaunchPlanV1, AgentProviderOperationErrorV1,
    AgentProviderPreflightPlanV1, AgentProviderPromptTargetV1, AgentProviderRegistrationErrorV1,
    AgentProviderRegistry, AgentProviderSessionLaunchPlanV1, AgentProviderStructuredSessionPlanV1,
    AgentProviderStructuredSessionRequestV1, agent_provider_launch_prompt_is_valid,
};
pub use agent_runtime_close::*;
pub use agent_runtime_rehost::*;
pub use agent_runtime_transition::*;
pub use agent_spawn::{
    AGENT_SPAWN_SCHEMA_VERSION_V1, AgentSpawnAuthorityV1, AgentSpawnBranchModeV1,
    AgentSpawnCommittedWorkspaceV1, AgentSpawnContractErrorV1, AgentSpawnEffortSelectionV1,
    AgentSpawnExistingWorkspaceAuthorityV1, AgentSpawnInteractionPreferenceV1,
    AgentSpawnJournalEventBodyV1, AgentSpawnJournalEventV1, AgentSpawnJournalReceiptV1,
    AgentSpawnJournalStateV1, AgentSpawnJournalStore, AgentSpawnLaunchPlanV1,
    AgentSpawnModelSelectionV1, AgentSpawnPermissionModeV1, AgentSpawnPlanDraftV1,
    AgentSpawnPlanIntentDraftV1, AgentSpawnPlanTokenV1, AgentSpawnPlanV1,
    AgentSpawnPreviewIntentV1, AgentSpawnPreviewRequestV1, AgentSpawnPromptDigestV1,
    AgentSpawnRecoveryDirectiveV1, AgentSpawnRuntimePlanV1, AgentSpawnSourceRuntimeAuthorityV1,
    AgentSpawnSourceSelectionAuthorityV1, AgentSpawnStageDispositionV1, AgentSpawnStageEvidenceV1,
    AgentSpawnStageInputsV1, AgentSpawnStageReceiptV1, AgentSpawnStageV1,
    AgentSpawnTerminalOutcomeV1, AgentSpawnWorkspaceLeaseV1, AgentSpawnWorktreePolicyV1,
    create_agent_spawn_plan_from_defaults_v1, create_agent_spawn_plan_v1,
    fold_agent_spawn_journal_v1, structured_prompt_identity, validate_agent_spawn_plan_intent_v1,
    worktree_directory_name,
};
pub use agent_timeline::*;
pub use backend_observation::is_durable_agent_observation;
pub use browser_profile::{
    BrowserProfileIdV1, BrowserProfileRecordV1, BrowserProfileScopeV1, BrowserProfileSpecV1,
    BrowserProfileStateV1, BrowserProfileStore, BrowserProfileUserAgentModeV1,
};
pub use client_view_state::{
    CLIENT_VIEW_STATE_SCHEMA_VERSION_V1, ClientIdV1, ClientInstanceIdV1, ClientViewAuthorityV1,
    ClientViewFilterV1, ClientViewGenerationAdvanceRequestV1, ClientViewGenerationReceiptV1,
    ClientViewIdErrorV1, ClientViewIdV1, ClientViewIdentityV1, ClientViewLayoutSlotV1,
    ClientViewNamespaceV1, ClientViewPresentationV1, ClientViewRecordV1,
    ClientViewSubscriptionTopicV1, ClientViewSubscriptionV1, ClientViewViewportV1,
    ClientViewWriteReceiptV1, ClientViewWriteRequestV1, MAX_CLIENT_VIEW_FILTERS_V1,
    MAX_CLIENT_VIEW_LAYOUT_SLOTS_V1, MAX_CLIENT_VIEW_STATE_BYTES_V1,
    MAX_CLIENT_VIEW_SUBSCRIPTIONS_V1, MAX_CLIENT_VIEW_VIEWPORTS_V1, MAX_CLIENT_VIEWS_PER_CLIENT_V1,
    TenantIdV1, UserIdV1,
};
pub use codegen::typescript_contracts;
pub use compatibility::{
    CompatibilityOutcomeV1, ExtensionAvailabilityV1, HostCompatibilityV1,
    MissingRequiredCapabilitiesV1, UnavailableReasonV1, evaluate_compatibility,
};
pub use contract::{
    AgentProviderContractV1, ApiVersionRangeV1, CURRENT_EXTENSION_API_VERSION,
    CapabilityDeclarationV1, CapabilityIdV1, DescriptorValidationError,
    EXTENSION_DESCRIPTOR_SCHEMA_VERSION, ExtensionContractV1, ExtensionDescriptorV1,
    ExtensionFailureCodeV1, ExtensionIdV1, FileViewProviderContractV1,
    PREVIOUS_EXTENSION_API_VERSION, PermissionIdV1, ProviderIdV1, RuntimeAdapterContractV1,
    RuntimeKindIdV1, StableIdError, WorkspaceToolKindIdV1, WorkspaceToolProviderContractV1,
};
pub use domain_store::{
    AGENT_CHECKPOINT_SCHEMA_VERSION_V1, AgentCheckpointBindingAuthorityV1,
    AgentCheckpointIdentityV1, AgentCheckpointObservationV1, AgentCheckpointRecordV1,
    AgentCheckpointWriteReceiptV1, AgentCheckpointWriteRequestV1, AgentIdV1, AgentRecordV1,
    CURRENT_STORE_READER_VERSION, CURRENT_STORE_SCHEMA_VERSION, CURRENT_STORE_WRITER_VERSION,
    DomainIdErrorV1, DomainStore, DomainStoreErrorV1, DomainStoreFuture,
    MIN_SUPPORTED_STORE_SCHEMA_VERSION, OperationEventBodyV1, OperationEventIdV1, OperationEventV1,
    OperationIdV1, OperationReceiptStateV1, OperationReceiptV1, ProjectIdV1, ProjectRecordV1,
    ReviewIdV1, ReviewTargetRecordV1, ReviewTargetRetentionPolicyV1, ReviewTargetRootSnapshotV1,
    ReviewTargetSweepReceiptV1, SessionBindingRecordV1, StoreSchemaInfoV1, WorkspaceIdV1,
    WorkspaceRecordV1, fold_operation_events,
};
pub use dure_app_protocol::{
    GIT_CHECKOUT_SCHEMA_VERSION_V1, GIT_CHECKOUT_USE_SCHEMA_VERSION_V1,
    GitCheckoutCaptureRequestV1, GitCheckoutCreationReservationV1, GitCheckoutInstanceV1,
    GitCheckoutLocationV1, GitCheckoutReferenceV1, GitCheckoutRegistrationV1,
    GitCheckoutRemovalOutcomeV1, GitCheckoutRemovalPermitV1, GitCheckoutRemovalPolicyV1,
    GitCheckoutRemovalReceiptV1, GitCheckoutRemovalRequestV1, GitCheckoutUseActionV1,
    GitCheckoutUseClaimV1, GitCheckoutUseOutcomeV1, GitCheckoutUsePhaseV1,
    GitCheckoutUsePhysicalRemovalRequestV1, GitCheckoutUseReceiptV1, GitCheckoutUseRequestV1,
    GitCheckoutUseRevisionV1, MAX_BACKEND_CAPABILITIES_V1, MAX_GIT_CHECKOUT_USE_ACTIVE_CLAIMS_V1,
    MAX_GIT_CHECKOUT_USE_PATH_BYTES_V1, MAX_GIT_CHECKOUT_USE_REVISION_V1,
};
pub use issue_tracker::{
    ISSUE_TRACKER_QUERY_LIMIT_V1, ISSUE_TRACKER_SCHEMA_VERSION_V1,
    IssueTrackerAgentBindingSourceV1, IssueTrackerAgentBindingV1, IssueTrackerContractErrorV1,
    IssueTrackerCountsV1, IssueTrackerIssueDetailV1, IssueTrackerIssueIdV1,
    IssueTrackerIssueSummaryV1, IssueTrackerMutationDeliveryV1, IssueTrackerOperationV1,
    IssueTrackerProviderV1, IssueTrackerQueryResultV1, IssueTrackerQueryV1,
    IssueTrackerRepositoryWrapperV1, IssueTrackerWatchEventV1, IssueTrackerWatchSnapshotV1,
    IssueTrackerWatchStateV1, IssueTrackerWatchSubscriptionV1,
};
pub use issue_tracker_v2::{
    ISSUE_TRACKER_QUERY_LIMIT_V2, ISSUE_TRACKER_SCHEMA_VERSION_V2, IssueTrackerAgentTaskBindingV2,
    IssueTrackerAgentTaskContextV2, IssueTrackerCapabilityIdV2, IssueTrackerCommonOperationV2,
    IssueTrackerConnectionIdV2, IssueTrackerContractErrorV2, IssueTrackerDataAuthorityV2,
    IssueTrackerEntityIdV2, IssueTrackerLifecycleV2, IssueTrackerNamedValueV2,
    IssueTrackerProviderStatusV2, IssueTrackerProviderV2, IssueTrackerQueryResultV2,
    IssueTrackerQueryV2, IssueTrackerScopeIdV2, IssueTrackerSourceV2, IssueTrackerTaskDetailV2,
    IssueTrackerTaskDisplayKeyV2, IssueTrackerTaskIdV2, IssueTrackerTaskRefV2,
    IssueTrackerTaskSummaryV2,
};
pub use plugin_apply_compensation::{
    PluginApplyCompensationLinkV2, PluginApplyCompensationPlanErrorV2,
    PluginApplyCompensationStepV2, create_plugin_apply_compensation_started_event,
    plan_plugin_apply_compensation, plugin_apply_compensation_identity,
    validate_plugin_apply_compensation_child, validate_plugin_apply_compensation_completion,
    validate_plugin_apply_compensation_link, validate_plugin_apply_compensation_steps,
};
pub use plugin_apply_execution::{
    PluginApplyExecutionDecisionErrorV2, PluginApplyStepCompletionV2, complete_plugin_apply_step,
    prepare_plugin_apply_step, reconcile_plugin_apply_step, select_plugin_apply_recovery,
};
pub use plugin_apply_journal::{
    PluginApplyEffectDispositionV2, PluginApplyEffectReceiptV2, PluginApplyJournalErrorV2,
    PluginApplyJournalEventBodyV2, PluginApplyJournalEventV2, PluginApplyJournalReceiptV2,
    PluginApplyJournalStateV2, PluginApplyJournalStore, PluginApplyOperationKindV2,
    PluginApplyRecoveryDirectiveV2, PluginApplyRecoveryStrategyV2, PluginApplyStepCheckpointV2,
    PluginApplyStepReconciliationV2, PluginApplyStepV2, PluginNativeCommandHostFailureV2,
    PluginNativeCommandOutcomeV2, PluginTargetStateDigestV2, fold_plugin_apply_journal,
};
pub use plugin_apply_start::{
    PluginApplyStartErrorV2, PluginApplyStartRequestV2, create_plugin_apply_started_event,
};
pub use plugin_contract::{
    AgentAdapterIdV2, AgentInstallScopeV2, AgentIntegrationDescriptorV2, AgentIntegrationIdV2,
    AgentNativeMarketplaceNameV2, AgentNativePluginNameV2, AgentNativePluginSelectorV2,
    AgentProfileIdV2, AgentTargetIdV2, ContractVersionRangeV2, ContributionDescriptorV2,
    ContributionFamilyIdV2, ContributionIdV2, PLUGIN_MANIFEST_SCHEMA_VERSION_V2,
    PermissionKindIdV2, PermissionRequestV2, PhysicalTargetKeyV2, PluginActivationEventV2,
    PluginContractValidationErrorV2, PluginIdV2, PluginManifestV2, PluginPlacementV2,
    PluginPublisherIdV2, PluginResourcePathV2, PluginVersionV2,
};
pub use plugin_native_ownership::{
    PluginNativeOwnedComponentV2, PluginNativeOwnershipChangeV2, PluginNativeOwnershipErrorV2,
    PluginNativeOwnershipKeyV2, PluginNativeOwnershipLedgerEventBodyV2,
    PluginNativeOwnershipLedgerEventV2, PluginNativeOwnershipReceiptV2,
    PluginNativeOwnershipTargetV2, derive_plugin_native_ownership_ledger_event,
    fold_plugin_native_ownership_ledger, plugin_native_ownership_target,
    plugin_native_ownership_target_for_journal_event,
};
pub use plugin_native_state::{
    PluginNativeInstallationStateV2, PluginNativeMarketplaceStateV2,
    PluginNativeStateObservationV2, PluginNativeTargetStateV2, digest_plugin_native_target_state,
};
pub use plugin_native_target_binding::{
    PluginNativeApplyAuthorityStore, PluginNativePhysicalTargetBindingV2,
    PluginNativePhysicalTargetDigestV2, PluginNativePhysicalTargetRoleV2,
    PluginNativeTargetBindingErrorV2, required_plugin_native_physical_targets,
    validate_plugin_native_physical_target_bindings,
};
pub use plugin_native_transition::{
    PluginNativeCheckpointReconciliationV2, PluginNativeExistingOwnershipV2,
    PluginNativeMutationObservationV2, PluginNativeReconciliationErrorV2,
    PluginNativeTransitionErrorV2, classify_plugin_native_mutation,
    reconcile_plugin_native_checkpoint,
};
pub use plugin_package_registry::{
    InMemoryPluginPackageSourceV2, MAX_EMBEDDED_PLUGIN_PACKAGE_BYTES_V2,
    MAX_EMBEDDED_PLUGIN_PACKAGE_FILE_BYTES_V2, MAX_EMBEDDED_PLUGIN_PACKAGE_FILES_V2,
    PluginAgentIntegrationResourceTreeV2, PluginBundledAuthorityIdV2,
    PluginCatalogResourceFingerprintV2, PluginCatalogSnapshotSha256V2, PluginPackageCandidateIdV2,
    PluginPackageCatalogSnapshotV2, PluginPackageConflictCandidateV2,
    PluginPackageEmbeddedAuthoritySha256V2, PluginPackageEmbeddedAuthorityV2,
    PluginPackageEmbeddedFileManifestSha256V2, PluginPackageRegistryErrorV2,
    PluginPackageRegistryV2, PluginPackageSourceCandidateV2, PluginPackageSourceErrorV2,
    PluginPackageSourceIdV2, PluginPackageSourceRegistrationV2, PluginPackageSourceRejectionV2,
    PluginPackageSourceV2, RegisteredPluginPackageV2, ResolvedPluginAgentIntegrationV2,
    ResolvedPluginContributionV2,
};
pub use plugin_permission::{
    MAX_PLUGIN_PERMISSION_REVIEW_ENTRIES_V2, MAX_PLUGIN_PERMISSION_REVIEW_PROJECTION_BYTES_V2,
    PLUGIN_PERMISSION_PLAN_SCHEMA_VERSION_V2,
    PLUGIN_PERMISSION_REVIEW_PROJECTION_SCHEMA_VERSION_V2, PluginBundledCatalogAuthoritySummaryV2,
    PluginBundledPermissionPackageV2, PluginCatalogSelectionV2, PluginPermissionContributionPlanV2,
    PluginPermissionErrorV2, PluginPermissionHostPolicyV2, PluginPermissionIdentityV2,
    PluginPermissionKindPolicyV2, PluginPermissionParameterPolicyV2,
    PluginPermissionPlanComparisonV2, PluginPermissionPlanDigestV2, PluginPermissionPlanV2,
    PluginPermissionPolicyDigestV2, PluginPermissionReviewChangeV2, PluginPermissionReviewDiffV2,
    PluginPermissionReviewEntryV2, PluginPermissionReviewFieldV2,
    PluginPermissionReviewProjectionDigestV2, PluginPermissionReviewProjectionV2,
    PluginPermissionReviewSubjectV2, PluginPermissionReviewValueV2, PluginWorkspaceIdentityV2,
    canonicalize_plugin_permission_plan, compare_plugin_permission_plan_digest,
    diff_plugin_permission_review_projections,
};
pub use plugin_permission_state::{
    MAX_PLUGIN_PERMISSION_DECISION_EVENTS_V2,
    MAX_PLUGIN_PERMISSION_DECISION_EVENTS_WITH_DISABLE_RESERVE_V2,
    PLUGIN_PERMISSION_DECISION_CHECKPOINT_SCHEMA_VERSION_V2,
    PLUGIN_PERMISSION_DECISION_SCHEMA_VERSION_V2, PluginPermissionDecisionBindingV2,
    PluginPermissionDecisionErrorV2, PluginPermissionDecisionEventApplicationV2,
    PluginPermissionDecisionEventBodyV2, PluginPermissionDecisionEventDispositionV2,
    PluginPermissionDecisionEventV2, PluginPermissionDecisionFoldCheckpointV2,
    PluginPermissionDecisionFoldV2, PluginPermissionDecisionKeyV2,
    PluginPermissionDecisionReplayBodyV2, PluginPermissionDecisionReplayReceiptV2,
    PluginPermissionDecisionRequestApplicationV2, PluginPermissionDecisionRequestIdV2,
    PluginPermissionDecisionRequestV2, PluginPermissionDecisionStateV2, PluginPermissionDecisionV2,
    PluginPermissionEnablementV2, PluginPermissionExecutionErrorV2,
    PluginPermissionExecutionLeaseV2, apply_plugin_permission_decision_event,
    apply_plugin_permission_decision_request, evaluate_plugin_permission_execution,
    fold_plugin_permission_decision_events, revalidate_plugin_permission_execution_lease,
};
pub use plugin_registry::{
    AgentAdapterSupportV2, ContributionFamilySupportV2, NegotiatedContributionV2,
    PluginCompatibilityOutcomeV2, PluginHostContractV2, negotiate_plugin_manifest,
};
pub use plugin_settings::{
    PLUGIN_SETTINGS_SCHEMA_VERSION_V1, PluginSettingChoiceV1, PluginSettingDefinitionV1,
    PluginSettingKeyV1, PluginSettingScopeV1, PluginSettingValueV1, PluginSettingsSchemaV1,
};
pub use plugin_views::{
    PLUGIN_VIEWS_SCHEMA_VERSION_V1, PluginIssueTrackerAgentClaimsSurfaceV1,
    PluginIssueTrackerAgentClaimsV1, PluginIssueTrackerDefaultQueryV1,
    PluginIssueTrackerQueryTitlesV1, PluginLocalizedTextV1, PluginViewContainerIdV1,
    PluginViewContainerLocationV1, PluginViewContainerV1, PluginViewIconV1, PluginViewIdV1,
    PluginViewKindV1, PluginViewV1, PluginViewsV1,
};
pub use plugin_workflows::{
    PLUGIN_WORKFLOWS_SCHEMA_VERSION_V1, PluginWorkflowContributionV1, WorkflowKindIdV1,
};
pub use provider_credential_profile::{
    PROVIDER_CREDENTIAL_PROFILE_SCHEMA_VERSION_V1, ProviderCredentialEnvironmentPolicyV1,
    ProviderCredentialProfileDirectoryNameV1, ProviderCredentialProfileRegistrationV1,
    ProviderCredentialProfileStore, ProviderCredentialProfileV1,
    provider_credential_environment_policy_v1,
};
pub use provider_execution::ProviderPermissionModeV1;
pub use provider_launch_defaults::{
    PROVIDER_LAUNCH_DEFAULTS_SCHEMA_VERSION_V1, ProviderLaunchDefaultV1,
    ProviderLaunchDefaultsContractErrorV1, ProviderLaunchDefaultsFingerprintV1,
    ProviderLaunchDefaultsPutDispositionV1, ProviderLaunchDefaultsPutReceiptV1,
    ProviderLaunchDefaultsPutRequestV1, ProviderLaunchDefaultsResolutionV1,
    ProviderLaunchDefaultsV1, ProviderLaunchPermissionModeV1, ProviderLaunchPermissionOverrideV1,
};
pub use provider_runtime_integration::{
    PROVIDER_RUNTIME_INTEGRATIONS_FILE_V1, PROVIDER_RUNTIME_INTEGRATIONS_SCHEMA_VERSION_V1,
    ProviderRuntimeIntegrationContractErrorV1, ProviderRuntimeIntegrationV1,
    ProviderRuntimeIntegrationsV1, codex_lifecycle_hook_arguments_v1,
};
pub use registry::{
    ExtensionImplementation, ExtensionProbeContextV1, ExtensionProbeOutcomeV1, ExtensionRegistry,
    RegistrationOutcomeV1,
};
pub use runtime_adapter_registry::{
    RuntimeAdapterFutureV1, RuntimeAdapterImplementation, RuntimeAdapterOperationErrorV1,
    RuntimeAdapterRegistrationErrorV1, RuntimeAdapterRegistry, RuntimeSessionProbeReceiptV1,
};
pub use schedule::{
    SCHEDULE_OCCURRENCE_SCHEMA_VERSION_V2, SCHEDULE_SCHEMA_VERSION_V1, ScheduleDeleteRequestV1,
    ScheduleIdV1, ScheduleLaunchStateV1, ScheduleMutationErrorV1, ScheduleOccurrenceRecordV2,
    SchedulePutRequestV1, ScheduleRecordV1, ScheduleRunSummaryV1, ScheduleRunTemplateV1,
    ScheduleTriggerV1, ScheduleWorkspacePolicyV1,
};
pub use session_checkout::{
    AgentRuntimeRemovalPlanV1, AgentRuntimeRemovalV1, SessionCheckoutAdmissionV1,
    SessionCheckoutBindingV1, SessionCheckoutIdentityV1, SessionCheckoutOwnerV1,
    SessionCheckoutRecordV1,
};
pub use workflow::{
    DELEGATE_ONCE_SCHEMA_VERSION_V1, DelegateOnceCompletionRequestV1, DelegateOncePreparedV1,
    DelegateOncePromptActivityRequestV1, DelegateOncePromptClaimRequestV1,
    DelegateOncePromptOutcomeRequestV1, DelegateOnceReceiptV1, DelegateOnceRequestV1,
    DelegateOnceSessionBindingRequestV1, DelegateOnceStartFailureRequestV1, DelegateOnceTaskSpecV1,
    DispatchIdV1, RunIdV1, TaskIdV1, WorkflowAgentPromptDeliveryEvidenceV1,
    WorkflowControllerPromptDeliveryEvidenceV1, WorkflowCoordinatorBindingV1,
    WorkflowDispatchStateV1, WorkflowEffectiveLaunchRepairRequestV1,
    WorkflowPromptActivityFailureV1, WorkflowPromptActivityFutureV1,
    WorkflowPromptActivityObservationRequestV1, WorkflowPromptActivityObserver,
    WorkflowPromptActivityReceiptV1, WorkflowPromptActivityStateV1, WorkflowPromptDeliverer,
    WorkflowPromptDeliveryClaimV1, WorkflowPromptDeliveryEvidenceV1,
    WorkflowPromptDeliveryFailureV1, WorkflowPromptDeliveryFutureV1,
    WorkflowPromptDeliveryIntentV1, WorkflowPromptDeliveryOperationV1,
    WorkflowPromptDeliveryOutcomeV1, WorkflowPromptDeliveryReceiptV1,
    WorkflowPromptDeliveryRequestV1, WorkflowPromptDeliveryStateV1, WorkflowSessionGenerationV1,
    WorkflowSessionLaunchFailureDispositionV1, WorkflowSessionLaunchFailureV1,
    WorkflowSessionLaunchFutureV1, WorkflowSessionLaunchReceiptV1, WorkflowSessionLaunchRequestV1,
    WorkflowSessionPrelaunchCommandV1, WorkflowSessionResumePlanV1, WorkflowStore,
    prepare_delegate_once, prepare_delegate_once_handoff,
    validate_workflow_effective_launch_identity, workflow_prepared_session_id,
};
