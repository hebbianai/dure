use super::*;

pub(super) struct RealHmux {
    pub root: PathBuf,
    pub discovery: PathBuf,
    runtime: PathBuf,
    requests: Arc<StdMutex<Vec<WorkflowSessionLaunchRequestV1>>>,
}

impl RealHmux {
    pub fn install(root: TempDir, state: &mut ServiceState) -> Self {
        let guardian = PathBuf::from(std::env::var_os("DURE_HMUX_TEST_STATE_ROOT").expect(
            "run this smoke through scripts/run-hmux-tests.mjs so fixture cleanup is supervised",
        ));
        assert!(root.path().canonicalize().unwrap().starts_with(guardian));
        let runtime = PathBuf::from(std::env::var_os("DURE_QA_HMUX_RUNTIME").unwrap())
            .canonicalize()
            .unwrap();
        let cli = PathBuf::from(std::env::var_os("DURE_QA_HMUX_BIN").unwrap())
            .canonicalize()
            .unwrap();
        // Keep discovery evidence until the outer guardian has retired every
        // exact Host generation, including when a test panics during launch.
        let root = root.keep();
        let discovery = root.join("real-runtime-discovery");
        fs::create_dir(&discovery).unwrap();
        fs::set_permissions(&discovery, fs::Permissions::from_mode(0o700)).unwrap();
        state.hmux_identity = resolve_hmux_toolchain_identity(&cli, &runtime, &discovery).unwrap();
        state.runtime_adapters = Arc::new(runtime_extension::local_hmux_runtime_registry(
            state.hmux_identity.clone(),
        ));
        let requests = Arc::new(StdMutex::new(Vec::new()));
        state.credential_aware_workflow_launcher = Arc::new(ObservedLauncher {
            inner: workflow_launch::HmuxWorkflowSessionLauncher::new(
                runtime.clone(),
                discovery.clone(),
            ),
            requests: Arc::clone(&requests),
        });
        state.workflow_prompt_deliverer =
            Arc::new(workflow_launch::HmuxWorkflowPromptDeliverer::new(
                discovery.clone(),
                state.agent_providers.clone(),
            ));
        state.workflow_prompt_activity_observer = Arc::new(
            workflow_launch::HmuxWorkflowPromptActivityObserver::new(discovery.clone()),
        );
        Self {
            root,
            discovery,
            runtime,
            requests,
        }
    }

    pub fn requests(&self) -> Vec<WorkflowSessionLaunchRequestV1> {
        self.requests.lock().unwrap().clone()
    }

    pub fn session(&self, session: &WorkflowSessionGenerationV1) -> hmux_client::SessionDescriptor {
        hmux_client::LocalSessionCatalog::new(&self.discovery)
            .find(&hmux_client::SessionSelector::new(
                &session.session_id,
                Some(session.workspace_id.clone()),
            ))
            .unwrap()
    }

    pub async fn assert_exited(session: &hmux_client::SessionDescriptor) {
        // The stop reply precedes Host exit. Observe disappearance within the
        // existing shutdown window, without signals or guardian intervention.
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let exited = [&session.host_process, &session.provider_process]
                    .iter()
                    .all(|process| {
                        hmux_client::probe_local_process_generation(process).unwrap()
                            == hmux_client::LocalProcessGenerationStatus::Absent
                    });
                if exited {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("Product hibernation did not release the exact Host/provider generations");
    }

    pub fn stop(&self, session: &WorkflowSessionGenerationV1) {
        let request = ManagedStopRequest::new(
            format!("qa-stop-{}", session.session_id),
            &session.session_id,
            &session.workspace_id,
        )
        .unwrap()
        .with_expected_fence(
            &session.runner_principal,
            &session.runner_instance,
            session.channel_epoch.parse().unwrap(),
            &session.host_instance_id,
            &session.terminal_epoch,
        )
        .unwrap();
        let receipt = hmux_client::ManagedSessionStopper::new(&self.runtime, &self.root)
            .with_discovery_root(&self.discovery)
            .stop(request)
            .unwrap();
        assert!(matches!(
            receipt.outcome(),
            ManagedStopOutcome::Stopped | ManagedStopOutcome::AlreadyExited
        ));
    }
}

struct ObservedLauncher {
    inner: workflow_launch::HmuxWorkflowSessionLauncher,
    requests: Arc<StdMutex<Vec<WorkflowSessionLaunchRequestV1>>>,
}

impl workflow_launch::CredentialAwareWorkflowSessionLauncher for ObservedLauncher {
    fn launch_with_provider_state(
        &self,
        request: WorkflowSessionLaunchRequestV1,
        environment: ProviderStateEnvironment,
        predecessor: Option<hmux_client::PresentationCheckpointPredecessor>,
    ) -> WorkflowSessionLaunchFutureV1 {
        self.requests.lock().unwrap().push(request.clone());
        self.inner
            .launch_with_provider_state(request, environment, predecessor)
    }
}
