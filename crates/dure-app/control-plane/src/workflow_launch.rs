use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::thread;
use std::time::Duration;

use dure_app::{
    AgentProviderPromptTargetV1, AgentProviderRegistry, AgentSpawnStartupGateKindV1,
    WorkflowPromptActivityFailureV1, WorkflowPromptActivityFutureV1,
    WorkflowPromptActivityObservationRequestV1, WorkflowPromptActivityObserver,
    WorkflowPromptActivityReceiptV1, WorkflowPromptActivityStateV1, WorkflowPromptDeliverer,
    WorkflowPromptDeliveryEvidenceV1, WorkflowPromptDeliveryFailureV1,
    WorkflowPromptDeliveryFutureV1, WorkflowPromptDeliveryIntentV1,
    WorkflowPromptDeliveryRequestV1, WorkflowSessionGenerationV1, WorkflowSessionLaunchFailureV1,
    WorkflowSessionLaunchFutureV1, WorkflowSessionLaunchReceiptV1, WorkflowSessionLaunchRequestV1,
};
use hmux_client::{
    LocalSessionCatalog, LocalSessionObserver, ManagedCreateAdvanceResolution,
    ManagedCreateFailureDisposition, ManagedSessionCreator, ObserverAttachOptions, ObserverEvent,
    PresentationCheckpointPredecessor, ProviderConversationIdentitySeed, ProviderStateEnvironment,
    SessionClass, SessionDescriptor, SessionFence, SessionLifecycle, SessionSelector,
    TerminalSurfaceAttachment,
};

#[cfg(test)]
use hmux_client::{MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION, ManagedCreateRequest};

const PROMPT_DELIVERY_TIMEOUT: Duration = Duration::from_secs(30);
const PROMPT_ACTIVITY_TIMEOUT: Duration = Duration::from_secs(5);
/// Codex reports its first turn, or its sign-in screen, within seconds of
/// launch. The bound matters only when the Host shows neither.
const LAUNCH_PROMPT_OBSERVATION_TIMEOUT: Duration = Duration::from_secs(30);
const MANAGED_CREATE_PENDING_CODE: &str = "hmux_managed_create_pending";

mod checkout;
pub(crate) use checkout::launch_independent;
mod managed_create;
use managed_create::managed_create_request;

#[derive(Clone)]
pub(crate) struct HmuxWorkflowSessionLauncher {
    runtime_executable: PathBuf,
    discovery_root: PathBuf,
}

/// Ephemeral provider-state material stays in the control-plane adapter and
/// never enters the durable workflow request. Both production and tests use
/// this one port, so credential launches cannot bypass lifecycle injection.
pub(crate) trait CredentialAwareWorkflowSessionLauncher: Send + Sync {
    fn launch_with_provider_state(
        &self,
        request: WorkflowSessionLaunchRequestV1,
        provider_state_environment: ProviderStateEnvironment,
        presentation_predecessor: Option<PresentationCheckpointPredecessor>,
    ) -> WorkflowSessionLaunchFutureV1;

    /// Tell the Host that the provider just launched into `session` stops at
    /// a first-run prompt before it reads any input, so its agent runtime
    /// state carries `input_required` instead of a merely waiting agent. A
    /// launcher without a Host projection accepts the report and keeps nothing.
    fn report_startup_gate(
        &self,
        _session: WorkflowSessionGenerationV1,
        _gate: AgentSpawnStartupGateKindV1,
    ) -> StartupGateReportFuture<'_> {
        Box::pin(async { Ok(()) })
    }

    /// Watch the Host's agent state for the session just launched into
    /// `session` until the provider either takes up the prompt its launch
    /// command carried or asks a person for input first. `None` claims
    /// nothing: the Host showed neither in time or could not be observed. A
    /// launcher without a Host projection observes nothing.
    fn observe_launch_prompt(
        &self,
        _session: WorkflowSessionGenerationV1,
    ) -> LaunchPromptObservationFuture<'_> {
        Box::pin(async { None })
    }
}

pub(crate) type StartupGateReportFuture<'a> =
    Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>>;

/// What the Host's agent state says about a prompt the launch command handed
/// the provider.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum LaunchPromptObservation {
    /// The provider started a turn: it took the prompt up.
    TakenUp,
    /// The provider asks a person for input before its first turn, so it is
    /// stopped ahead of the prompt.
    InputRequired,
}

pub(crate) type LaunchPromptObservationFuture<'a> =
    Pin<Box<dyn Future<Output = Option<LaunchPromptObservation>> + Send + 'a>>;

/// Every first-run prompt is a question to the person: the provider waits and
/// needs input. The gate's kind stays in the spawn receipt because the Host
/// projection is provider-neutral.
fn startup_gate_report() -> hmux_client::AgentStateReport {
    hmux_client::AgentStateReport {
        progress: None,
        identity_only: false,
        activity: hmux_client::AgentRuntimeActivity::Waiting,
        attention: hmux_client::AgentRuntimeAttention::InputRequired,
        turn_completed: false,
        turn_completion_id: None,
        causality: None,
        working_ttl_ms: None,
        conversation_identity: None,
        expected_observation: None,
        background_work: false,
    }
}

impl HmuxWorkflowSessionLauncher {
    pub(crate) fn new(runtime_executable: PathBuf, discovery_root: PathBuf) -> Self {
        Self {
            runtime_executable,
            discovery_root,
        }
    }

    fn launch_with_environment(
        &self,
        request: WorkflowSessionLaunchRequestV1,
        provider_state_environment: ProviderStateEnvironment,
        presentation_predecessor: Option<PresentationCheckpointPredecessor>,
    ) -> WorkflowSessionLaunchFutureV1 {
        let runtime_executable = self.runtime_executable.clone();
        let discovery_root = self.discovery_root.clone();
        Box::pin(async move {
            request
                .validate()
                .map_err(|_| rejected_failure("workflow_launch_invalid"))?;
            if request.runtime_kind_id.as_str() != "runtime.hmux" {
                return Err(rejected_failure("workflow_runtime_unsupported"));
            }
            tokio::task::spawn_blocking(move || {
                let managed = managed_create_request(
                    &request,
                    provider_state_environment,
                    presentation_predecessor,
                )?;
                let resolution = ManagedSessionCreator::new(&runtime_executable)
                    .with_discovery_root(&discovery_root)
                    .create_or_reconcile_and_advance(managed);
                match resolution {
                    Ok(
                        ManagedCreateAdvanceResolution::Current(created)
                        | ManagedCreateAdvanceResolution::Advanced(created),
                    ) => {
                        let descriptor = created.session().descriptor();
                        Ok(WorkflowSessionLaunchReceiptV1 {
                            launch_idempotency_key: created.receipt().idempotency_key().to_owned(),
                            session: WorkflowSessionGenerationV1 {
                                session_id: descriptor.session_id.clone(),
                                workspace_id: descriptor.workspace_id.clone(),
                                provider_id: request.provider_id,
                                runner_principal: descriptor.runner_principal.clone(),
                                runner_instance: descriptor.runner_instance.clone(),
                                channel_epoch: descriptor.channel_epoch.clone(),
                                host_instance_id: descriptor.host_instance_id.clone(),
                                terminal_epoch: descriptor.terminal_epoch.clone(),
                            },
                        })
                    }
                    Ok(ManagedCreateAdvanceResolution::Pending) => {
                        Err(failure(MANAGED_CREATE_PENDING_CODE))
                    }
                    Ok(ManagedCreateAdvanceResolution::AuthorityUnavailable(authority)) => {
                        Err(failure(&authority.code))
                    }
                    Err(error) => Err(match error.disposition() {
                        ManagedCreateFailureDisposition::Rejected => rejected_failure(error.code()),
                        ManagedCreateFailureDisposition::Retryable => failure(error.code()),
                    }),
                }
            })
            .await
            .map_err(|_| failure("workflow_launch_worker_failed"))?
        })
    }
}

impl CredentialAwareWorkflowSessionLauncher for HmuxWorkflowSessionLauncher {
    fn launch_with_provider_state(
        &self,
        request: WorkflowSessionLaunchRequestV1,
        provider_state_environment: ProviderStateEnvironment,
        presentation_predecessor: Option<PresentationCheckpointPredecessor>,
    ) -> WorkflowSessionLaunchFutureV1 {
        self.launch_with_environment(
            request,
            provider_state_environment,
            presentation_predecessor,
        )
    }

    fn report_startup_gate(
        &self,
        session: WorkflowSessionGenerationV1,
        _gate: AgentSpawnStartupGateKindV1,
    ) -> StartupGateReportFuture<'_> {
        let runtime_executable = self.runtime_executable.clone();
        let discovery_root = self.discovery_root.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                let fence = workflow_session_fence(&session).map_err(|failure| failure.code)?;
                let request = hmux_client::ManagedAttachRequest::new(
                    &session.session_id,
                    &session.workspace_id,
                )
                .map_err(|error| error.to_string())?;
                let cwd = std::env::current_dir()
                    .map_err(|_| "startup_gate_report_cwd_unavailable".to_string())?;
                // The fence pins the report to the generation this launch
                // created, so a successor Host never inherits the gate.
                let outcome = hmux_client::ManagedAgentStateReporter::new(runtime_executable, cwd)
                    .with_discovery_root(discovery_root)
                    .report_agent_state_for_fence(request, startup_gate_report(), fence)
                    .map_err(|error| error.code().to_string())?;
                match outcome {
                    hmux_client::AgentStateReportOutcome::Applied
                    | hmux_client::AgentStateReportOutcome::NoOp => Ok(()),
                    hmux_client::AgentStateReportOutcome::DroppedExited => {
                        Err("startup_gate_report_provider_exited".to_string())
                    }
                }
            })
            .await
            .map_err(|_| "startup_gate_report_worker_failed".to_string())?
        })
    }

    fn observe_launch_prompt(
        &self,
        session: WorkflowSessionGenerationV1,
    ) -> LaunchPromptObservationFuture<'_> {
        let discovery_root = self.discovery_root.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                observe_launch_prompt(&discovery_root, &session, LAUNCH_PROMPT_OBSERVATION_TIMEOUT)
            })
            .await
            .ok()
            .flatten()
        })
    }
}

/// Watch the exact session generation until its agent state settles what
/// became of the launch prompt, or the timeout passes. Every failure to
/// observe ends in `None`: the Hub then claims nothing it did not see.
fn observe_launch_prompt(
    discovery_root: &std::path::Path,
    session: &WorkflowSessionGenerationV1,
    timeout: Duration,
) -> Option<LaunchPromptObservation> {
    let catalog = LocalSessionCatalog::new(discovery_root);
    let selector = SessionSelector::new(&session.session_id, Some(session.workspace_id.clone()));
    let deadline = std::time::Instant::now() + timeout;
    let mut observer = LocalSessionObserver::connect(
        &catalog,
        &selector,
        ObserverAttachOptions::default()
            .with_handshake_timeout(timeout)
            .with_handshake_completion_timeout(timeout)
            .with_handshake_deadline(deadline),
    )
    .ok()?;
    let initial = observer
        .attachment()
        .initial_snapshot
        .agent_runtime_state
        .as_deref()
        .map(|state| launch_prompt_state(state, &session.terminal_epoch));
    let settled = match initial {
        _ if !exact_observer_matches(observer.attachment(), session) => Some(None),
        Some(LaunchPromptState::Settled(observation)) => Some(Some(observation)),
        Some(LaunchPromptState::Gone) => Some(None),
        Some(LaunchPromptState::Pending) | None => None,
    };
    if let Some(observation) = settled {
        let _ = observer.detach();
        return observation;
    }
    let Ok(interrupt) = observer.interrupt_handle() else {
        let _ = observer.detach();
        return None;
    };
    let (cancel_watchdog, watchdog_cancelled) = mpsc::channel::<()>();
    let remaining = deadline.saturating_duration_since(std::time::Instant::now());
    let watchdog = thread::spawn(move || {
        if watchdog_cancelled.recv_timeout(remaining).is_err() {
            interrupt.interrupt();
        }
    });
    let observation = loop {
        match observer.read_event() {
            Ok(Some(ObserverEvent::AgentRuntimeState(state))) => {
                match launch_prompt_state(&state, &session.terminal_epoch) {
                    LaunchPromptState::Pending => {}
                    LaunchPromptState::Settled(observation) => break Some(observation),
                    LaunchPromptState::Gone => break None,
                }
            }
            // Agent state frames are whole states, so a missed output range
            // loses nothing this watch reads.
            Ok(Some(
                ObserverEvent::Output(_)
                | ObserverEvent::Snapshot(_)
                | ObserverEvent::ProviderConversationIdentity(_)
                | ObserverEvent::ReplayGap(_),
            )) => {}
            Ok(Some(ObserverEvent::Exit(_)) | None) | Err(_) => break None,
        }
    };
    let _ = cancel_watchdog.send(());
    let _ = watchdog.join();
    let _ = observer.detach();
    observation
}

enum LaunchPromptState {
    Pending,
    Settled(LaunchPromptObservation),
    /// The provider exited or the session moved on to another terminal.
    Gone,
}

/// A working provider, or one that already finished a turn, took the launch
/// prompt up. One asking for input before its first turn is stopped ahead of
/// it. Anything else, such as the waiting state of a provider that is still
/// starting, is not evidence yet.
fn launch_prompt_state(
    state: &hmux_client::AgentRuntimeStateDescriptor,
    terminal_epoch: &str,
) -> LaunchPromptState {
    if state.terminal_epoch != terminal_epoch
        || state.lifecycle == hmux_client::AgentRuntimeLifecycle::Exited
    {
        return LaunchPromptState::Gone;
    }
    let turn_completed = state
        .turn_completed_count
        .parse::<u64>()
        .is_ok_and(|count| count > 0);
    if state.activity == hmux_client::AgentRuntimeActivity::Working || turn_completed {
        LaunchPromptState::Settled(LaunchPromptObservation::TakenUp)
    } else if state.attention == hmux_client::AgentRuntimeAttention::InputRequired {
        LaunchPromptState::Settled(LaunchPromptObservation::InputRequired)
    } else {
        LaunchPromptState::Pending
    }
}

#[cfg(test)]
mod launch_prompt_tests {
    use super::*;
    use hmux_client::{
        AgentRuntimeActivity as Activity, AgentRuntimeAttention as Attention,
        AgentRuntimeLifecycle as Lifecycle, AgentRuntimeStateDescriptor,
    };

    fn state(
        lifecycle: Lifecycle,
        activity: Activity,
        attention: Attention,
        turns: &str,
    ) -> AgentRuntimeStateDescriptor {
        AgentRuntimeStateDescriptor {
            progress: None,
            terminal_epoch: "terminal-1".into(),
            revision: "2".into(),
            observed_through_output_seq: "40".into(),
            lifecycle,
            activity,
            attention,
            attention_id: (attention != Attention::None).then(|| "attention-1".into()),
            source: hmux_client::AgentRuntimeStateSource::ProviderEvent,
            turn_completed_count: turns.into(),
            program_status: None,
            background_work: false,
        }
    }

    fn read(state: &AgentRuntimeStateDescriptor) -> Option<Option<LaunchPromptObservation>> {
        match launch_prompt_state(state, "terminal-1") {
            LaunchPromptState::Pending => None,
            LaunchPromptState::Settled(observation) => Some(Some(observation)),
            LaunchPromptState::Gone => Some(None),
        }
    }

    #[test]
    fn a_turn_takes_the_prompt_up_and_input_before_any_turn_stops_ahead_of_it() {
        use LaunchPromptObservation::{InputRequired, TakenUp};
        for (lifecycle, activity, attention, turns, expected) in [
            // Codex's driver reports readiness before the account is read.
            (
                Lifecycle::Running,
                Activity::Waiting,
                Attention::None,
                "0",
                None,
            ),
            (
                Lifecycle::Starting,
                Activity::Waiting,
                Attention::None,
                "0",
                None,
            ),
            (
                Lifecycle::Running,
                Activity::Waiting,
                Attention::InputRequired,
                "0",
                Some(Some(InputRequired)),
            ),
            (
                Lifecycle::Running,
                Activity::Working,
                Attention::None,
                "0",
                Some(Some(TakenUp)),
            ),
            // A turn that already finished took the prompt up, whatever came next.
            (
                Lifecycle::Running,
                Activity::Waiting,
                Attention::InputRequired,
                "1",
                Some(Some(TakenUp)),
            ),
            (
                Lifecycle::Running,
                Activity::Waiting,
                Attention::None,
                "1",
                Some(Some(TakenUp)),
            ),
            (
                Lifecycle::Exited,
                Activity::Waiting,
                Attention::None,
                "0",
                Some(None),
            ),
        ] {
            assert_eq!(
                read(&state(lifecycle, activity, attention, turns)),
                expected,
                "{lifecycle:?} {activity:?} {attention:?} turns={turns}"
            );
        }
    }

    #[test]
    fn another_terminal_generation_settles_nothing_about_this_launch() {
        let mut successor = state(
            Lifecycle::Running,
            Activity::Waiting,
            Attention::InputRequired,
            "0",
        );
        successor.terminal_epoch = "terminal-2".into();
        assert_eq!(read(&successor), Some(None));
    }
}

#[cfg(test)]
mod permission_tests {
    use super::managed_create::managed_launch_command;
    use super::*;
    use dure_app::ProviderPermissionModeV1;
    use hmux_client::PermissionMode;
    use std::collections::BTreeMap;

    fn launch_request(prelaunch_command: Option<&str>) -> WorkflowSessionLaunchRequestV1 {
        WorkflowSessionLaunchRequestV1 {
            runtime_kind_id: dure_app::RuntimeKindIdV1::new("runtime.hmux").unwrap(),
            launch_idempotency_key: "launch-1".into(),
            session_id: "session-1".into(),
            workspace_id: "workspace-1".into(),
            provider_id: dure_app::ProviderIdV1::new("codex").unwrap(),
            provider_conversation_ref: None,
            permission_mode: ProviderPermissionModeV1::Default,
            provider_executable: "/opt/dure/bin/codex".into(),
            provider_arguments: Vec::new(),
            provider_resume: None,
            initial_prompt: None,
            working_directory: "/tmp/workspace".into(),
            prelaunch_command: prelaunch_command
                .map(|command| dure_app::WorkflowSessionPrelaunchCommandV1::new(command).unwrap()),
        }
    }

    #[test]
    fn claude_launch_and_resume_keep_hooks_and_use_the_same_account_project_memory() {
        use dure_app::{AgentExecutionProfileV1, WorkflowSessionResumePlanV1};
        use hmux_client::{
            MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER, ManagedRehostSourceRecipe,
        };
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("accounts/claude-work");
        std::fs::create_dir_all(&profile).unwrap();
        let environment = ProviderStateEnvironment::new(BTreeMap::from([(
            "CLAUDE_CONFIG_DIR".into(),
            profile.to_string_lossy().into_owned(),
        )]))
        .unwrap();
        let mut request = launch_request(None);
        request.provider_id = dure_app::ProviderIdV1::new("claude").unwrap();
        request.provider_executable = "claude".into();
        request.working_directory = root.path().to_string_lossy().into_owned();
        request.provider_arguments = vec![
            "--settings".into(),
            r#"{"hooks":{"SessionStart":[]}}"#.into(),
        ];
        request.initial_prompt = Some("keep this prompt".into());
        request.provider_resume = WorkflowSessionResumePlanV1::from_arguments(
            Some(vec![
                "--settings".into(),
                request.provider_arguments[1].clone(),
                "--resume".into(),
                MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER.into(),
            ]),
            &AgentExecutionProfileV1::CredentialReference {
                reference_id: "work".into(),
                credential_generation: Some("generation".into()),
            },
        );
        let managed = managed_create_request(&request, environment.clone(), None).unwrap();
        let settings: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&managed.command()[2]).unwrap()).unwrap();
        let memory = std::path::Path::new(settings["autoMemoryDirectory"].as_str().unwrap());
        assert!(memory.is_dir());
        assert!(!memory.starts_with(&profile));
        assert_eq!(settings["hooks"]["SessionStart"], serde_json::json!([]));
        assert_eq!(managed.command().last().unwrap(), "keep this prompt");
        assert_eq!(managed.provider_state_environment(), &environment);
        let recipe = ManagedRehostSourceRecipe::from_create_request(&managed)
            .unwrap()
            .unwrap();
        let resume = recipe.rehost().render_command("conversation").unwrap();
        assert_eq!(resume[2], managed.command()[2]);
        assert_eq!(&resume[3..], &["--resume", "conversation"]);
    }

    #[test]
    fn resume_recipe_preserves_launch_profile_without_replaying_setup_or_prompt() {
        use dure_app::{AgentExecutionProfileV1, WorkflowSessionResumePlanV1};
        use hmux_client::{
            MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER, ManagedRehostSourceRecipe,
        };

        let mut request = launch_request(Some("printf setup"));
        request.initial_prompt = Some("initial task".into());
        request.provider_resume = WorkflowSessionResumePlanV1::from_arguments(
            Some(vec![
                "resume".into(),
                MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER.into(),
            ]),
            &AgentExecutionProfileV1::CredentialReference {
                reference_id: "selected-account".into(),
                credential_generation: Some("selected-generation".into()),
            },
        );
        let environment = ProviderStateEnvironment::new(BTreeMap::from([(
            "CODEX_HOME".into(),
            "/fixture/selected-profile".into(),
        )]))
        .unwrap();
        let managed = managed_create_request(&request, environment.clone(), None).unwrap();
        let mut legacy_request = request.clone();
        legacy_request.provider_resume = None;
        let legacy = managed_create_request(&legacy_request, environment.clone(), None).unwrap();
        assert_eq!(
            managed.canonical_create_identity_json().unwrap(),
            legacy.canonical_create_identity_json().unwrap(),
            "adding resume metadata must not invalidate an admitted create",
        );
        let recipe = ManagedRehostSourceRecipe::from_create_request(&managed)
            .unwrap()
            .unwrap();
        assert_eq!(
            recipe.provider_cwd().to_str(),
            Some(request.working_directory.as_str())
        );
        assert_eq!(recipe.provider_state_environment(), &environment);
        assert_eq!(recipe.rehost().launch_reference(), Some("selected-account"));
        assert_eq!(
            recipe
                .rehost()
                .render_command("learned-conversation")
                .unwrap(),
            [
                request.provider_executable,
                "resume".into(),
                "learned-conversation".into()
            ],
        );
        assert!(managed.command().contains(&"initial task".into()));
        assert!(managed.command().contains(&"printf setup".into()));
    }

    #[test]
    fn launch_only_request_remains_launchable_without_a_rehost_recipe() {
        let managed = managed_create_request(
            &launch_request(None),
            ProviderStateEnvironment::default(),
            None,
        )
        .unwrap();
        assert!(
            hmux_client::ManagedRehostSourceRecipe::from_create_request(&managed)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn provider_permission_policy_maps_to_the_exact_hmux_mode() {
        assert_eq!(
            crate::provider_permission::to_hmux(ProviderPermissionModeV1::Default),
            PermissionMode::Default
        );
        assert_eq!(
            crate::provider_permission::to_hmux(ProviderPermissionModeV1::SkipPermissions),
            PermissionMode::BypassApprovals
        );
    }

    #[test]
    fn selected_provider_state_environment_reaches_the_private_hmux_packet() {
        let mut request = launch_request(None);
        request.provider_id = dure_app::ProviderIdV1::new("claude").unwrap();
        let environment = ProviderStateEnvironment::new(BTreeMap::from([(
            "CLAUDE_CONFIG_DIR".into(),
            "/tmp/claude-profile".into(),
        )]))
        .unwrap();

        let managed = managed_create_request(&request, environment.clone(), None).unwrap();

        assert_eq!(managed.provider_state_environment(), &environment);
        assert!(!format!("{managed:?}").contains("/tmp/claude-profile"));
    }

    #[test]
    fn exact_provider_conversation_reaches_the_private_hmux_packet() {
        let mut request = launch_request(None);
        request.provider_conversation_ref = Some("conversation-1".into());

        let managed =
            managed_create_request(&request, ProviderStateEnvironment::default(), None).unwrap();

        assert_eq!(
            managed
                .conversation_identity()
                .map(ProviderConversationIdentitySeed::conversation_id),
            Some("conversation-1")
        );
        assert_eq!(
            managed.required_managed_stop_request_version(),
            Some(MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION),
            "a new Native workflow must not launch a Host it cannot later stop with its exact conversation fence"
        );
    }

    #[test]
    fn presentation_predecessor_reaches_the_private_hmux_packet() {
        let predecessor = PresentationCheckpointPredecessor::new(
            "source-session",
            "source-runner",
            "source-instance",
            7,
            "source-host",
            "source-terminal",
        )
        .unwrap();

        let managed = managed_create_request(
            &launch_request(None),
            ProviderStateEnvironment::default(),
            Some(predecessor.clone()),
        )
        .unwrap();

        assert_eq!(managed.presentation_predecessor(), Some(&predecessor));
    }

    #[test]
    fn setup_runs_before_the_provider_in_the_same_managed_session() {
        assert_eq!(
            managed_launch_command(&launch_request(Some("pnpm install && printf '%s' done")))
                .unwrap(),
            vec![
                "/bin/sh",
                "-c",
                "set -e; /bin/sh -c \"$1\"; shift; \"$@\"; status=$?; exit \"$status\"",
                "dure-agent-setup",
                "pnpm install && printf '%s' done",
                "/opt/dure/bin/codex",
            ]
        );
    }

    #[test]
    fn a_launch_without_setup_executes_the_provider_directly() {
        assert_eq!(
            managed_launch_command(&launch_request(None)).unwrap(),
            vec!["/opt/dure/bin/codex"]
        );
    }

    #[test]
    fn launch_prompt_is_the_final_provider_argument_with_or_without_setup() {
        for setup in [None, Some("pnpm install")] {
            let mut request = launch_request(setup);
            request.provider_arguments = vec!["resume".into(), "conversation-1".into()];
            request.initial_prompt = Some("continue here".into());
            let command = managed_launch_command(&request).unwrap();
            assert_eq!(
                &command[command.len() - 5..],
                [
                    "/opt/dure/bin/codex",
                    "resume",
                    "conversation-1",
                    "--",
                    "continue here",
                ]
            );
        }
    }

    #[test]
    fn opencode_launch_uses_the_named_prompt_without_replacing_prepared_settings() {
        let mut request = launch_request(None);
        request.provider_id = dure_app::ProviderIdV1::new("opencode").unwrap();
        request.provider_executable = "/opt/dure/bin/opencode".into();
        request.provider_arguments =
            vec!["--model".into(), "fixture/model".into(), "--auto".into()];
        request.initial_prompt = Some("한글 입력\ncontinue here".into());
        assert_eq!(
            managed_launch_command(&request).unwrap(),
            vec![
                "/opt/dure/bin/opencode",
                "--model",
                "fixture/model",
                "--auto",
                "--prompt",
                "한글 입력\ncontinue here",
            ]
        );
        request.provider_conversation_ref = Some("ses_exact_fixture".into());
        assert!(managed_launch_command(&request).is_err());
    }

    #[test]
    fn completion_adapter_and_skip_permissions_reach_the_actual_codex_argv() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt;
        use std::process::Command;

        let fixture = tempfile::tempdir().unwrap();
        let provider = fixture.path().join("codex-capture");
        let capture = fixture.path().join("argv.txt");
        fs::write(
            &provider,
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$DURE_PROVIDER_ARGV_CAPTURE\"\n",
        )
        .unwrap();
        fs::set_permissions(&provider, fs::Permissions::from_mode(0o755)).unwrap();

        let mut request = launch_request(None);
        request.permission_mode = ProviderPermissionModeV1::SkipPermissions;
        request.provider_arguments =
            crate::provider_extension::test_local_agent_provider_registry()
                .launch_plan(
                    &request.provider_id,
                    &request.permission_mode,
                    None,
                    None,
                    None,
                )
                .unwrap()
                .unwrap()
                .arguments;
        request.provider_executable = provider.to_string_lossy().into_owned();
        let command = managed_launch_command(&request).unwrap();
        let status = Command::new(&command[0])
            .args(&command[1..])
            .env("DURE_PROVIDER_ARGV_CAPTURE", &capture)
            .status()
            .unwrap();

        assert!(status.success());
        let expected = format!(
            "{}\n",
            crate::provider_extension::test_codex_provider_arguments(
                ProviderPermissionModeV1::SkipPermissions,
            )
            .join("\n")
        );
        assert_eq!(fs::read_to_string(capture).unwrap(), expected);
    }

    #[test]
    fn setup_failure_prevents_provider_launch_and_success_preserves_output_order() {
        let mut successful = launch_request(Some("printf 'setup\\n'"));
        successful.provider_executable = "/bin/echo".into();
        let command = managed_launch_command(&successful).unwrap();
        let output = std::process::Command::new(&command[0])
            .args(&command[1..])
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"setup\n\n");

        let mut failed = launch_request(Some("printf 'setup failed\\n'; exit 7"));
        failed.provider_executable = "/bin/echo".into();
        let command = managed_launch_command(&failed).unwrap();
        let output = std::process::Command::new(&command[0])
            .args(&command[1..])
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(7));
        assert_eq!(output.stdout, b"setup failed\n");
    }
}

#[derive(Clone)]
pub(crate) struct HmuxWorkflowPromptDeliverer {
    discovery_root: PathBuf,
    agent_providers: Arc<AgentProviderRegistry>,
}

impl HmuxWorkflowPromptDeliverer {
    pub(crate) fn new(
        discovery_root: PathBuf,
        agent_providers: Arc<AgentProviderRegistry>,
    ) -> Self {
        Self {
            discovery_root,
            agent_providers,
        }
    }
}

impl WorkflowPromptDeliverer for HmuxWorkflowPromptDeliverer {
    fn deliver(&self, request: WorkflowPromptDeliveryRequestV1) -> WorkflowPromptDeliveryFutureV1 {
        let discovery_root = self.discovery_root.clone();
        let agent_providers = Arc::clone(&self.agent_providers);
        Box::pin(async move {
            request
                .validate()
                .map_err(|_| prompt_failure("workflow_prompt_delivery_invalid", false))?;
            if request.runtime_kind_id.as_str() != "runtime.hmux" {
                return Err(prompt_failure("workflow_runtime_unsupported", false));
            }
            tokio::task::spawn_blocking(move || {
                deliver_agent_prompt(&discovery_root, &agent_providers, &request)
            })
            .await
            .map_err(|_| prompt_failure("workflow_prompt_delivery_worker_failed", true))?
        })
    }
}

#[derive(Clone)]
pub(crate) struct HmuxWorkflowPromptActivityObserver {
    discovery_root: PathBuf,
}

impl HmuxWorkflowPromptActivityObserver {
    pub(crate) fn new(discovery_root: PathBuf) -> Self {
        Self { discovery_root }
    }
}

impl WorkflowPromptActivityObserver for HmuxWorkflowPromptActivityObserver {
    fn observe(
        &self,
        request: WorkflowPromptActivityObservationRequestV1,
    ) -> WorkflowPromptActivityFutureV1 {
        let discovery_root = self.discovery_root.clone();
        Box::pin(async move {
            let baseline = request.input_baseline_output_sequence.clone();
            request
                .validate()
                .map_err(|_| activity_failure("workflow_prompt_activity_invalid", &baseline))?;
            if request.runtime_kind_id.as_str() != "runtime.hmux" {
                return Err(activity_failure("workflow_runtime_unsupported", &baseline));
            }
            let worker_baseline = baseline.clone();
            tokio::task::spawn_blocking(move || {
                let catalog = LocalSessionCatalog::new(discovery_root);
                let selector = SessionSelector::new(
                    &request.session.session_id,
                    Some(request.session.workspace_id.clone()),
                );
                let deadline = std::time::Instant::now() + PROMPT_ACTIVITY_TIMEOUT;
                let mut observer = LocalSessionObserver::connect(
                    &catalog,
                    &selector,
                    ObserverAttachOptions::default()
                        .with_handshake_timeout(PROMPT_ACTIVITY_TIMEOUT)
                        .with_handshake_completion_timeout(PROMPT_ACTIVITY_TIMEOUT)
                        .with_handshake_deadline(deadline),
                )
                .map_err(|error| activity_failure(error.code(), &worker_baseline))?;
                if !exact_observer_matches(observer.attachment(), &request.session) {
                    let _ = observer.detach();
                    return Err(activity_failure(
                        "workflow_prompt_session_stale",
                        &worker_baseline,
                    ));
                }

                let baseline_value = parse_output_seq(&worker_baseline, &worker_baseline)?;
                let initial = &observer.attachment().initial_snapshot;
                if initial.terminal_epoch != request.session.terminal_epoch {
                    let _ = observer.detach();
                    return Err(activity_failure(
                        "workflow_prompt_state_stale",
                        &worker_baseline,
                    ));
                }
                let initial_output_seq = initial.sequence_through.clone();
                let initial_value = parse_output_seq(&initial_output_seq, &worker_baseline)?;
                if initial_value < baseline_value {
                    let _ = observer.detach();
                    return Err(activity_failure(
                        "workflow_prompt_activity_sequence_regressed",
                        &initial_output_seq,
                    ));
                }
                if initial_value > baseline_value {
                    let observed = activity_observed(&initial_output_seq);
                    let _ = observer.detach();
                    return Ok(observed);
                }

                let interrupt = observer
                    .interrupt_handle()
                    .map_err(|error| activity_failure(error.code(), &initial_output_seq))?;
                let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                if remaining.is_zero() {
                    let stalled = activity_stalled(&initial_output_seq);
                    let _ = observer.detach();
                    return Ok(stalled);
                }
                let timed_out = Arc::new(AtomicBool::new(false));
                let watchdog_timeout = Arc::clone(&timed_out);
                let (cancel_watchdog, watchdog_cancelled) = mpsc::channel();
                let watchdog = thread::spawn(move || {
                    if watchdog_cancelled.recv_timeout(remaining).is_err() {
                        watchdog_timeout.store(true, Ordering::Release);
                        interrupt.interrupt();
                    }
                });
                let result = wait_for_prompt_activity(
                    &mut observer,
                    &request.session.terminal_epoch,
                    baseline_value,
                    initial_output_seq,
                    &timed_out,
                );
                let _ = cancel_watchdog.send(());
                let _ = watchdog.join();
                let _ = observer.detach();
                result
            })
            .await
            .map_err(|_| activity_failure("workflow_prompt_activity_worker_failed", &baseline))?
        })
    }
}

fn deliver_agent_prompt(
    discovery_root: &std::path::Path,
    agent_providers: &AgentProviderRegistry,
    request: &WorkflowPromptDeliveryRequestV1,
) -> Result<WorkflowPromptDeliveryEvidenceV1, WorkflowPromptDeliveryFailureV1> {
    let fence = workflow_session_fence(&request.session)?;
    let catalog = LocalSessionCatalog::new(discovery_root);
    let mut surface = TerminalSurfaceAttachment::connect_local_agent_prompt(&catalog, &fence)
        .map_err(|error| prompt_failure(error.code(), false))?;
    let delivery = match &request.intent {
        WorkflowPromptDeliveryIntentV1::FreshAgent => match agent_providers
            .prompt_target(&request.session.provider_id, None)
            .unwrap_or_default()
        {
            AgentProviderPromptTargetV1::ProviderEvent => surface
                .send_fresh_agent_prompt_confirmed(
                    request.handoff.clone(),
                    PROMPT_DELIVERY_TIMEOUT,
                ),
            AgentProviderPromptTargetV1::ProcessObserved
            | AgentProviderPromptTargetV1::LaunchArgument => surface
                .send_process_observed_fresh_agent_prompt_confirmed(
                    request.handoff.clone(),
                    PROMPT_DELIVERY_TIMEOUT,
                ),
        },
        WorkflowPromptDeliveryIntentV1::ExistingConversation {
            provider_conversation_id,
        } => {
            let expected = ProviderConversationIdentitySeed::new(
                request.session.provider_id.as_str(),
                provider_conversation_id,
            )
            .map_err(|_| prompt_failure("workflow_prompt_delivery_invalid", false))?;
            surface.send_existing_idle_agent_prompt_confirmed(
                request.handoff.clone(),
                &expected,
                PROMPT_DELIVERY_TIMEOUT,
            )
        }
    };
    let result = delivery
        .map_err(|error| prompt_failure(error.code(), error.delivery_state() != "not_written"))
        .map(|receipt| {
            WorkflowPromptDeliveryEvidenceV1::agent_prompt(
                receipt.terminal_epoch(),
                receipt.input().in_reply_to_record_id.to_string(),
                receipt.input_baseline_output_sequence().to_string(),
                receipt
                    .admitted_agent_runtime_revision()
                    .map(|revision| revision.to_string()),
            )
        });
    let _ = surface.detach();
    result
}

fn workflow_session_fence(
    session: &WorkflowSessionGenerationV1,
) -> Result<SessionFence, WorkflowPromptDeliveryFailureV1> {
    Ok(SessionFence {
        workspace_id: session.workspace_id.clone(),
        session_id: session.session_id.clone(),
        runner_principal: session.runner_principal.clone(),
        runner_instance: session.runner_instance.clone(),
        channel_epoch: session
            .channel_epoch
            .parse()
            .map_err(|_| prompt_failure("workflow_prompt_delivery_invalid", false))?,
        host_instance_id: session.host_instance_id.clone(),
        terminal_epoch: session.terminal_epoch.clone(),
    })
}

fn exact_observer_matches(
    attachment: &hmux_client::ObserverAttachment,
    expected: &WorkflowSessionGenerationV1,
) -> bool {
    exact_descriptor_matches(&attachment.session, expected)
        && attachment.negotiation.agent_runtime_state_projection
}

fn exact_descriptor_matches(
    actual: &SessionDescriptor,
    expected: &WorkflowSessionGenerationV1,
) -> bool {
    actual.session_class == SessionClass::Managed
        && actual.lifecycle == SessionLifecycle::Ready
        && actual.session_id == expected.session_id
        && actual.workspace_id == expected.workspace_id
        && actual.provider_id == expected.provider_id.as_str()
        && actual.runner_principal == expected.runner_principal
        && actual.runner_instance == expected.runner_instance
        && actual.channel_epoch == expected.channel_epoch
        && actual.host_instance_id == expected.host_instance_id
        && actual.terminal_epoch == expected.terminal_epoch
}

fn wait_for_prompt_activity(
    observer: &mut LocalSessionObserver,
    terminal_epoch: &str,
    baseline: u64,
    mut last_output_seq: String,
    timed_out: &AtomicBool,
) -> Result<WorkflowPromptActivityReceiptV1, WorkflowPromptActivityFailureV1> {
    let mut last_value = parse_output_seq(&last_output_seq, &last_output_seq)?;
    loop {
        match observer.read_event() {
            Ok(Some(ObserverEvent::Output(output))) => {
                if output.terminal_epoch != terminal_epoch {
                    return Err(activity_failure(
                        "workflow_prompt_state_stale",
                        &last_output_seq,
                    ));
                }
                let value = parse_output_seq(&output.output_seq, &last_output_seq)?;
                if value < last_value {
                    return Err(activity_failure(
                        "workflow_prompt_activity_sequence_regressed",
                        &last_output_seq,
                    ));
                }
                last_value = value;
                last_output_seq = output.output_seq;
                if value > baseline {
                    return Ok(activity_observed(&last_output_seq));
                }
            }
            Ok(Some(ObserverEvent::Snapshot(snapshot))) => {
                if snapshot.terminal_epoch != terminal_epoch {
                    return Err(activity_failure(
                        "workflow_prompt_state_stale",
                        &last_output_seq,
                    ));
                }
                let value = parse_output_seq(&snapshot.sequence_through, &last_output_seq)?;
                if value < last_value {
                    return Err(activity_failure(
                        "workflow_prompt_activity_sequence_regressed",
                        &last_output_seq,
                    ));
                }
                last_value = value;
                last_output_seq = snapshot.sequence_through;
                if value > baseline {
                    return Ok(activity_observed(&last_output_seq));
                }
            }
            Ok(Some(ObserverEvent::AgentRuntimeState(state))) => {
                if state.terminal_epoch != terminal_epoch {
                    return Err(activity_failure(
                        "workflow_prompt_state_stale",
                        &last_output_seq,
                    ));
                }
                let value = parse_output_seq(&state.observed_through_output_seq, &last_output_seq)?;
                if value < last_value {
                    return Err(activity_failure(
                        "workflow_prompt_activity_sequence_regressed",
                        &last_output_seq,
                    ));
                }
                last_value = value;
                last_output_seq = state.observed_through_output_seq;
                if value > baseline {
                    return Ok(activity_observed(&last_output_seq));
                }
            }
            Ok(Some(ObserverEvent::ReplayGap(gap))) => {
                let current = parse_output_seq(&gap.current_output_seq, &last_output_seq)?;
                if current < last_value {
                    return Err(activity_failure(
                        "workflow_prompt_activity_sequence_regressed",
                        &last_output_seq,
                    ));
                }
                return Err(activity_failure(
                    "workflow_prompt_activity_replay_gap",
                    &gap.current_output_seq,
                ));
            }
            Ok(Some(ObserverEvent::Exit(exit))) => {
                let final_output_seq = parse_output_seq(&exit.final_output_seq, &last_output_seq)?;
                if final_output_seq < last_value {
                    return Err(activity_failure(
                        "workflow_prompt_activity_sequence_regressed",
                        &last_output_seq,
                    ));
                }
                return Err(activity_failure(
                    "workflow_prompt_provider_exited",
                    &exit.final_output_seq,
                ));
            }
            Ok(Some(ObserverEvent::ProviderConversationIdentity(_))) => {}
            Ok(None) => {
                if timed_out.load(Ordering::Acquire) {
                    return Ok(activity_stalled(&last_output_seq));
                }
                return Err(activity_failure(
                    "workflow_prompt_provider_exited",
                    &last_output_seq,
                ));
            }
            Err(error) => {
                if timed_out.load(Ordering::Acquire) {
                    return Ok(activity_stalled(&last_output_seq));
                }
                return Err(activity_failure(error.code(), &last_output_seq));
            }
        }
    }
}

fn parse_output_seq(value: &str, last_valid: &str) -> Result<u64, WorkflowPromptActivityFailureV1> {
    if value.is_empty()
        || value.len() > 20
        || !value.bytes().all(|byte| byte.is_ascii_digit())
        || (value != "0" && value.starts_with('0'))
    {
        return Err(activity_failure(
            "workflow_prompt_activity_sequence_invalid",
            last_valid,
        ));
    }
    value
        .parse()
        .map_err(|_| activity_failure("workflow_prompt_activity_sequence_invalid", last_valid))
}

fn activity_observed(output_seq: &str) -> WorkflowPromptActivityReceiptV1 {
    WorkflowPromptActivityReceiptV1 {
        state: WorkflowPromptActivityStateV1::Observed,
        observed_output_seq: output_seq.into(),
        error_code: None,
    }
}

fn activity_stalled(output_seq: &str) -> WorkflowPromptActivityReceiptV1 {
    WorkflowPromptActivityReceiptV1 {
        state: WorkflowPromptActivityStateV1::Stalled,
        observed_output_seq: output_seq.into(),
        error_code: Some("workflow_prompt_stalled".into()),
    }
}

fn activity_failure(code: impl Into<String>, output_seq: &str) -> WorkflowPromptActivityFailureV1 {
    WorkflowPromptActivityFailureV1::new(code, output_seq).unwrap_or_else(|_| {
        WorkflowPromptActivityFailureV1::new("workflow_prompt_activity_failed", "0")
            .expect("static prompt activity failure is valid")
    })
}

fn failure(code: impl Into<String>) -> WorkflowSessionLaunchFailureV1 {
    WorkflowSessionLaunchFailureV1::new(code).expect("static launch failure code is valid")
}

fn rejected_failure(code: impl Into<String>) -> WorkflowSessionLaunchFailureV1 {
    WorkflowSessionLaunchFailureV1::rejected(code).expect("launch failure code is valid")
}

fn prompt_failure(
    code: impl Into<String>,
    may_have_written: bool,
) -> WorkflowPromptDeliveryFailureV1 {
    WorkflowPromptDeliveryFailureV1::new(code, may_have_written).unwrap_or_else(|_| {
        WorkflowPromptDeliveryFailureV1::new("workflow_prompt_delivery_failed", may_have_written)
            .expect("static prompt delivery failure code is valid")
    })
}

#[cfg(all(test, unix))]
mod prompt_delivery_integration_tests {
    use super::*;
    use dure_app::{ProviderIdV1, RuntimeKindIdV1, WorkflowPromptDeliveryOperationV1};
    use hmux_client::{
        ManagedSessionStopper, ManagedStopOutcome, ManagedStopRequest, PermissionMode,
    };
    use std::os::unix::fs::PermissionsExt;

    /// The Hub's launch-prompt watch against a real Host: the reports Codex's
    /// native driver sends for a signed-out account (readiness, then its
    /// sign-in screen) settle the watch as `InputRequired`, and the first turn
    /// after sign-in settles a later watch as `TakenUp`.
    #[tokio::test]
    #[ignore = "requires DURE_QA_HMUX_RUNTIME"]
    async fn launch_prompt_watch_reads_the_providers_own_host_reports() {
        let runtime = PathBuf::from(
            std::env::var_os("DURE_QA_HMUX_RUNTIME")
                .expect("DURE_QA_HMUX_RUNTIME must point to hmux-runtime"),
        )
        .canonicalize()
        .unwrap();
        let state = tempfile::tempdir().unwrap();
        let discovery_root = state.path().join("discovery");
        let cwd = state.path().canonicalize().unwrap();
        let provider = state.path().join("codex");
        std::fs::write(&provider, b"#!/bin/sh\nexec sleep 60\n").unwrap();
        let mut permissions = std::fs::metadata(&provider).unwrap().permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&provider, permissions).unwrap();
        let created = ManagedSessionCreator::new(&runtime)
            .with_discovery_root(&discovery_root)
            .create(
                ManagedCreateRequest::new(
                    "dure-launch-prompt-watch-create",
                    "dure-launch-prompt-watch",
                    "dure-launch-prompt-watch-workspace",
                    "codex",
                    PermissionMode::Default,
                    &cwd,
                    vec![provider.to_string_lossy().into_owned()],
                    24,
                    80,
                )
                .unwrap(),
            )
            .unwrap();
        let descriptor = created.session().descriptor().clone();
        let session = WorkflowSessionGenerationV1 {
            session_id: descriptor.session_id.clone(),
            workspace_id: descriptor.workspace_id.clone(),
            provider_id: ProviderIdV1::new("codex").unwrap(),
            runner_principal: descriptor.runner_principal.clone(),
            runner_instance: descriptor.runner_instance.clone(),
            channel_epoch: descriptor.channel_epoch.clone(),
            host_instance_id: descriptor.host_instance_id.clone(),
            terminal_epoch: descriptor.terminal_epoch.clone(),
        };
        let report = |activity, attention| {
            let reporter = hmux_client::ManagedAgentStateReporter::new(&runtime, &cwd)
                .with_discovery_root(&discovery_root);
            let request =
                hmux_client::ManagedAttachRequest::new(&session.session_id, &session.workspace_id)
                    .unwrap();
            let fence = workflow_session_fence(&session).unwrap();
            let report = hmux_client::AgentStateReport {
                activity,
                attention,
                working_ttl_ms: (activity == hmux_client::AgentRuntimeActivity::Working)
                    .then_some(86_400_000),
                ..startup_gate_report()
            };
            tokio::task::spawn_blocking(move || {
                reporter
                    .report_agent_state_for_fence(request, report, fence)
                    .unwrap()
            })
        };
        let watch = |session: WorkflowSessionGenerationV1| {
            let launcher =
                HmuxWorkflowSessionLauncher::new(runtime.clone(), discovery_root.clone());
            tokio::spawn(async move { launcher.observe_launch_prompt(session).await })
        };

        let signed_out = watch(session.clone());
        // The driver's readiness report is not evidence either way.
        report(
            hmux_client::AgentRuntimeActivity::Waiting,
            hmux_client::AgentRuntimeAttention::None,
        )
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!signed_out.is_finished(), "readiness settled the watch");
        report(
            hmux_client::AgentRuntimeActivity::Waiting,
            hmux_client::AgentRuntimeAttention::InputRequired,
        )
        .await
        .unwrap();
        let signed_out = tokio::time::timeout(Duration::from_secs(10), signed_out)
            .await
            .expect("the sign-in report did not reach the watch")
            .unwrap();

        report(
            hmux_client::AgentRuntimeActivity::Working,
            hmux_client::AgentRuntimeAttention::None,
        )
        .await
        .unwrap();
        let signed_in = tokio::time::timeout(Duration::from_secs(10), watch(session.clone()))
            .await
            .expect("the first turn did not reach the watch")
            .unwrap();

        let stop = ManagedStopRequest::new(
            "dure-launch-prompt-watch-stop",
            &descriptor.session_id,
            &descriptor.workspace_id,
        )
        .and_then(|request| {
            request.with_expected_fence(
                &descriptor.runner_principal,
                &descriptor.runner_instance,
                descriptor.channel_epoch.parse().unwrap(),
                &descriptor.host_instance_id,
                &descriptor.terminal_epoch,
            )
        })
        .unwrap();
        let stopped = ManagedSessionStopper::new(&runtime, state.path())
            .with_discovery_root(&discovery_root)
            .stop(stop)
            .unwrap();
        assert_eq!(stopped.outcome(), ManagedStopOutcome::Stopped);
        assert_eq!(signed_out, Some(LaunchPromptObservation::InputRequired));
        assert_eq!(signed_in, Some(LaunchPromptObservation::TakenUp));
    }

    #[tokio::test]
    #[ignore = "requires DURE_QA_HMUX_RUNTIME"]
    async fn production_codex_prompt_bootstraps_without_a_provider_event() {
        let runtime = PathBuf::from(
            std::env::var_os("DURE_QA_HMUX_RUNTIME")
                .expect("DURE_QA_HMUX_RUNTIME must point to hmux-runtime"),
        )
        .canonicalize()
        .unwrap();
        let state = tempfile::tempdir().unwrap();
        let discovery_root = state.path().join("discovery");
        let received_prompt = state.path().join("received-prompt");
        let cwd = state.path().canonicalize().unwrap();
        let provider = state.path().join("codex");
        std::fs::write(
            &provider,
            b"#!/bin/sh\nstty -echo\nIFS= read -r prompt\nprintf '%s\\n' \"$prompt\" > \"$1\"\nexec sleep 60\n",
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&provider).unwrap().permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&provider, permissions).unwrap();
        let created = ManagedSessionCreator::new(&runtime)
            .with_discovery_root(&discovery_root)
            .create(
                ManagedCreateRequest::new(
                    "dure-workflow-agent-prompt-create",
                    "dure-workflow-agent-prompt",
                    "dure-workflow-agent-prompt-workspace",
                    "codex",
                    PermissionMode::Default,
                    &cwd,
                    vec![
                        provider.to_string_lossy().into_owned(),
                        received_prompt.to_string_lossy().into_owned(),
                    ],
                    24,
                    80,
                )
                .unwrap(),
            )
            .unwrap();
        let descriptor = created.session().descriptor();
        let session = WorkflowSessionGenerationV1 {
            session_id: descriptor.session_id.clone(),
            workspace_id: descriptor.workspace_id.clone(),
            provider_id: ProviderIdV1::new("codex").unwrap(),
            runner_principal: descriptor.runner_principal.clone(),
            runner_instance: descriptor.runner_instance.clone(),
            channel_epoch: descriptor.channel_epoch.clone(),
            host_instance_id: descriptor.host_instance_id.clone(),
            terminal_epoch: descriptor.terminal_epoch.clone(),
        };
        let deliverer = HmuxWorkflowPromptDeliverer::new(
            discovery_root.clone(),
            Arc::new(crate::provider_extension::test_agent_provider_registry(
                provider.to_str().unwrap(),
            )),
        );
        let delivery = tokio::spawn(async move {
            deliverer
                .deliver(WorkflowPromptDeliveryRequestV1 {
                    runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
                    delivery_idempotency_key: "dure-workflow-agent-prompt-delivery".into(),
                    session,
                    intent: WorkflowPromptDeliveryIntentV1::FreshAgent,
                    handoff: "dure workflow prompt".into(),
                })
                .await
        });
        let evidence = tokio::time::timeout(Duration::from_secs(5), delivery)
            .await
            .expect("process-observed Codex prompt delivery timed out")
            .unwrap()
            .unwrap();

        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        let written_prompt = loop {
            if let Ok(contents) = std::fs::read_to_string(&received_prompt) {
                break Some(contents);
            }
            if std::time::Instant::now() >= deadline {
                break None;
            }
            std::thread::sleep(Duration::from_millis(20));
        };

        let stop = ManagedStopRequest::new(
            "dure-workflow-agent-prompt-stop",
            &descriptor.session_id,
            &descriptor.workspace_id,
        )
        .and_then(|request| {
            request.with_expected_fence(
                &descriptor.runner_principal,
                &descriptor.runner_instance,
                descriptor.channel_epoch.parse().unwrap(),
                &descriptor.host_instance_id,
                &descriptor.terminal_epoch,
            )
        })
        .unwrap();
        let stopped = ManagedSessionStopper::new(&runtime, state.path())
            .with_discovery_root(&discovery_root)
            .stop(stop)
            .unwrap();
        assert_eq!(stopped.outcome(), ManagedStopOutcome::Stopped);
        assert_eq!(written_prompt.as_deref(), Some("dure workflow prompt\n"));

        let WorkflowPromptDeliveryEvidenceV1::AgentPrompt(agent_prompt) = evidence else {
            panic!("Dure used the legacy multi-write controller prompt path");
        };
        assert_eq!(
            agent_prompt.operation,
            WorkflowPromptDeliveryOperationV1::AgentPrompt
        );
        assert_eq!(agent_prompt.terminal_epoch, descriptor.terminal_epoch);
    }
}
