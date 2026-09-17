use super::*;

#[test]
fn quiescent_managed_stop_refuses_after_a_reserved_crash_and_controller_input() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery_root)
        .create(
            ManagedCreateRequest::new(
                "quiescent-stop-create",
                "quiescent-stop-target",
                "workspace-quiescent-stop",
                "codex",
                PermissionMode::Default,
                &cwd,
                vec!["/bin/sh".into(), "-c".into(), "stty -echo; sleep 30".into()],
                24,
                80,
            )
            .unwrap()
            .with_required_managed_stop_request_version(
                hmux_client::MANAGED_STOP_COMPLETE_FENCE_REQUEST_VERSION,
            )
            .unwrap(),
        )
        .unwrap();
    let reporter = ManagedAgentStateReporter::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root);
    let report_waiting = || AgentStateReport {
        identity_only: false,
        activity: hmux_client::AgentRuntimeActivity::Waiting,
        attention: hmux_client::AgentRuntimeAttention::None,
        turn_completed: false,
        turn_completion_id: None,
        causality: None,
        working_ttl_ms: None,
        conversation_identity: None,
        expected_observation: None,
    };
    assert!(matches!(
        reporter
            .report_agent_state(
                ManagedAttachRequest::new("quiescent-stop-target", "workspace-quiescent-stop",)
                    .unwrap(),
                report_waiting(),
            )
            .unwrap(),
        AgentStateReportOutcome::Applied | AgentStateReportOutcome::NoOp
    ));
    let catalog = LocalSessionCatalog::new(&discovery_root);
    let observe_quiescence = |pending| {
        let observer = LocalSessionObserver::connect(
            &catalog,
            &SessionSelector::new(
                "quiescent-stop-target",
                Some("workspace-quiescent-stop".into()),
            ),
            ObserverAttachOptions::default(),
        )
        .unwrap();
        let snapshot = &observer.attachment().initial_snapshot;
        assert_eq!(snapshot.controller_input_pending, Some(pending));
        let runtime = snapshot.agent_runtime_state.as_ref().unwrap();
        assert_eq!(runtime.activity, hmux_client::AgentRuntimeActivity::Waiting);
        assert_eq!(runtime.attention, hmux_client::AgentRuntimeAttention::None);
        let fence = ManagedStopQuiescenceFence::new(
            runtime.terminal_epoch.clone(),
            runtime.revision.parse().unwrap(),
            snapshot.sequence_through.parse().unwrap(),
        )
        .unwrap();
        observer.detach().unwrap();
        fence
    };
    let stale_quiescence = observe_quiescence(false);
    let waiting_revision = stale_quiescence.runtime_revision();
    let stale_request =
        exact_managed_stop_request("quiescent-stop-stale", created.session().descriptor())
            .with_expected_quiescence(stale_quiescence)
            .unwrap();
    run_faulted_managed_stop(&discovery_root, &cwd, &stale_request, "after_reserve");

    let mut controller = ManagedSessionAttacher::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .attach(
            ManagedAttachRequest::new("quiescent-stop-target", "workspace-quiescent-stop").unwrap(),
        )
        .unwrap();
    let input_id = controller
        .mutation_handle()
        .send_input(b"draft".to_vec())
        .unwrap();
    loop {
        match controller.read_event().unwrap() {
            Some(ControllerEvent::InputReceipt(receipt)) if receipt.request_id == input_id => {
                assert_eq!(receipt.state, ControllerReceiptState::WrittenToPty);
                break;
            }
            Some(_) => {}
            None => panic!("controller detached before the input receipt"),
        }
    }
    controller.detach().unwrap();

    let stopper = ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root);
    let stale_stop = stopper.stop(stale_request);
    let stale_error = stale_stop.unwrap_err();
    assert_eq!(
        stale_error.code(),
        "hmux_managed_stop_refused",
        "unexpected stale-fence stop error: {stale_error}"
    );
    assert_eq!(
        catalog
            .find(&SessionSelector::new(
                "quiescent-stop-target",
                Some("workspace-quiescent-stop".into()),
            ))
            .unwrap()
            .lifecycle,
        SessionLifecycle::Ready
    );

    let pending_draft = stopper
        .stop(
            exact_managed_stop_request(
                "quiescent-stop-pending-draft",
                created.session().descriptor(),
            )
            .with_expected_quiescence(observe_quiescence(true))
            .unwrap(),
        )
        .unwrap_err();
    assert_eq!(pending_draft.code(), "hmux_managed_stop_refused");

    let mut controller = ManagedSessionAttacher::new(env!("CARGO_BIN_EXE_hmux-runtime"), &cwd)
        .with_discovery_root(&discovery_root)
        .attach(
            ManagedAttachRequest::new("quiescent-stop-target", "workspace-quiescent-stop").unwrap(),
        )
        .unwrap();
    let submit_id = controller
        .mutation_handle()
        .send_input(b"\n".to_vec())
        .unwrap();
    loop {
        match controller.read_event().unwrap() {
            Some(ControllerEvent::InputReceipt(receipt)) if receipt.request_id == submit_id => {
                assert_eq!(receipt.state, ControllerReceiptState::WrittenToPty);
                break;
            }
            Some(_) => {}
            None => panic!("controller detached before the submit receipt"),
        }
    }
    controller.detach().unwrap();

    assert_eq!(
        observe_quiescence(true).runtime_revision(),
        waiting_revision
    );

    assert_eq!(
        reporter
            .report_agent_state(
                ManagedAttachRequest::new("quiescent-stop-target", "workspace-quiescent-stop",)
                    .unwrap(),
                report_waiting(),
            )
            .unwrap(),
        AgentStateReportOutcome::NoOp,
        "provider acknowledgement clears submitted input without inventing new activity"
    );
    let fresh_quiescence = observe_quiescence(false);
    assert_eq!(fresh_quiescence.runtime_revision(), waiting_revision);
    let stopped = stopper
        .stop(
            exact_managed_stop_request("quiescent-stop-fresh", created.session().descriptor())
                .with_expected_quiescence(fresh_quiescence)
                .unwrap(),
        )
        .unwrap();
    assert_eq!(stopped.outcome(), ManagedStopOutcome::Stopped);
}
