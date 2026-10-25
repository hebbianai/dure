use super::*;

/// The report a provider adapter sends when the provider's turn ended while
/// background work it started is still in flight.
fn turn_ended_with_background_work() -> AgentStateReport {
    AgentStateReport {
        progress: None,
        identity_only: false,
        activity: hmux_client::AgentRuntimeActivity::Waiting,
        attention: hmux_client::AgentRuntimeAttention::None,
        turn_completed: false,
        turn_completion_id: None,
        causality: None,
        working_ttl_ms: Some(hmux_client::AGENT_STATE_REPORT_MAX_WORKING_TTL_MS),
        conversation_identity: None,
        expected_observation: None,
        background_work: true,
    }
}

fn observe(
    discovery_root: &std::path::Path,
    descriptor: &hmux_client::SessionDescriptor,
) -> hmux_client::ScreenSnapshotDescriptor {
    let observer = LocalSessionObserver::connect(
        &LocalSessionCatalog::new(discovery_root),
        &SessionSelector::new(
            &descriptor.session_id,
            Some(descriptor.workspace_id.clone()),
        ),
        ObserverAttachOptions::default(),
    )
    .unwrap();
    let snapshot = observer.attachment().initial_snapshot.clone();
    observer.detach().unwrap();
    snapshot
}

/// A provider turn that ended while its background shells or agents still run
/// has a ready prompt. A wake reaches it, while the quiescent stop that an idle
/// switch or replacement needs stays refused so the background work survives.
#[test]
fn existing_conversation_agent_prompt_reaches_a_turn_that_ended_with_background_work() {
    let fixture = UnixAgentPromptFixture::new("background-work");
    let conversation_id = "conversation-background";
    fixture.report_waiting(conversation_id);
    let descriptor = fixture.created.session().descriptor();
    let ended = ManagedAgentStateReporter::new(fixture.runtime, &fixture.cwd)
        .with_discovery_root(&fixture.discovery_root)
        .report_agent_state(
            ManagedAttachRequest::new(&descriptor.session_id, &descriptor.workspace_id).unwrap(),
            turn_ended_with_background_work(),
        )
        .unwrap();
    assert_eq!(ended, AgentStateReportOutcome::Applied);

    let snapshot = observe(&fixture.discovery_root, descriptor);
    let runtime = snapshot.agent_runtime_state.as_ref().unwrap();
    assert_eq!(runtime.activity, hmux_client::AgentRuntimeActivity::Working);
    assert!(runtime.background_work);
    assert_eq!(snapshot.semantic_idle_ms, None);

    let refused = ManagedSessionStopper::new(fixture.runtime, &fixture.cwd)
        .with_discovery_root(&fixture.discovery_root)
        .stop(
            exact_managed_stop_request("background-work-idle-stop", descriptor)
                .with_expected_quiescence(
                    ManagedStopQuiescenceFence::new(
                        runtime.terminal_epoch.clone(),
                        runtime.revision.parse().unwrap(),
                        snapshot.sequence_through.parse().unwrap(),
                    )
                    .unwrap(),
                )
                .unwrap(),
        )
        .unwrap_err();
    assert_eq!(refused.code(), "hmux_managed_stop_refused");

    let expected = ProviderConversationIdentitySeed::new("codex", conversation_id).unwrap();
    let mut agent = fixture.surface();
    agent
        .send_existing_idle_agent_prompt_confirmed(
            "background wake".into(),
            &expected,
            Duration::from_secs(3),
        )
        .expect("a ready prompt with background work in flight must admit the wake");
    agent.detach().unwrap();
    wait_for_screen_text(
        fixture.created.session(),
        &["AGENT_PROMPT_CONSUMED:background wake"],
    );

    fixture.stop("background-work");
}

/// A Host that predates background work gets the working report it has always
/// received: its session stays busy, exactly as before.
#[test]
fn an_older_host_receives_background_work_as_the_working_report() {
    let state = tempfile::tempdir().unwrap();
    let discovery_root = state.path().join("discovery");
    let cwd = std::env::current_dir().unwrap().canonicalize().unwrap();
    let request = ManagedCreateRequest::new(
        "background-older-host-create",
        "background-older-host",
        "workspace-background-older-host",
        "codex",
        PermissionMode::Default,
        &cwd,
        vec!["/bin/sh".into(), "-c".into(), "stty -echo; sleep 30".into()],
        24,
        80,
    )
    .unwrap();
    let ManagedCreateBrokerResponse::Completed(_) = run_managed_create_with_omitted_capabilities(
        &discovery_root,
        &cwd,
        &request,
        hmux_client::AGENT_STATE_REPORT_BACKGROUND_WORK_CAPABILITY,
    ) else {
        panic!("the older Host fixture must start")
    };
    let descriptor = LocalSessionCatalog::new(&discovery_root)
        .find(&SessionSelector::new(
            "background-older-host",
            Some("workspace-background-older-host".into()),
        ))
        .unwrap();
    assert!(
        !descriptor
            .capabilities
            .iter()
            .any(|capability| capability
                == hmux_client::AGENT_STATE_REPORT_BACKGROUND_WORK_CAPABILITY)
    );
    let runtime = env!("CARGO_BIN_EXE_hmux-runtime");
    let outcome = ManagedAgentStateReporter::new(runtime, &cwd)
        .with_discovery_root(&discovery_root)
        .report_agent_state(
            ManagedAttachRequest::new(&descriptor.session_id, &descriptor.workspace_id).unwrap(),
            turn_ended_with_background_work(),
        )
        .unwrap();
    assert_eq!(outcome, AgentStateReportOutcome::Applied);
    let snapshot = observe(&discovery_root, &descriptor);
    let state_after = snapshot.agent_runtime_state.as_ref().unwrap();
    assert_eq!(
        state_after.activity,
        hmux_client::AgentRuntimeActivity::Working
    );
    assert!(!state_after.background_work);

    let stopped = ManagedSessionStopper::new(runtime, &cwd)
        .with_discovery_root(&discovery_root)
        .stop(exact_managed_stop_request(
            "background-older-host-stop",
            &descriptor,
        ))
        .unwrap();
    assert_eq!(stopped.outcome(), ManagedStopOutcome::Stopped);
}
