use super::*;
use std::process::Command;

fn signal(process_id: u32, name: &str) {
    assert!(
        Command::new("kill")
            .args([name, &process_id.to_string()])
            .status()
            .unwrap()
            .success()
    );
}

async fn launch_restorable(
    state: &ServiceState,
    hmux: &RealHmux,
    conversation: &str,
) -> WorkflowSessionGenerationV1 {
    state
        .credential_aware_workflow_launcher
        .launch_with_provider_state(
            WorkflowSessionLaunchRequestV1 {
                runtime_kind_id: RuntimeKindIdV1::new("runtime.hmux").unwrap(),
                launch_idempotency_key: format!("resume-all-{conversation}"),
                session_id: format!("resume-all-{conversation}"),
                workspace_id: "workspace-1".into(),
                provider_id: ProviderIdV1::new("codex").unwrap(),
                provider_conversation_ref: Some(conversation.to_owned()),
                permission_mode: ProviderPermissionModeV1::Default,
                provider_executable: hmux.root.join("codex-fixture").to_str().unwrap().into(),
                provider_arguments: vec!["resume".into(), conversation.into()],
                provider_resume: WorkflowSessionResumePlanV1::from_arguments(
                    Some(vec![
                        "resume".into(),
                        MANAGED_REHOST_EXACT_CONVERSATION_PLACEHOLDER.into(),
                    ]),
                    &AgentExecutionProfileV1::ProviderDefault,
                ),
                initial_prompt: None,
                working_directory: hmux.root.to_str().unwrap().into(),
                prelaunch_command: None,
            },
            ProviderStateEnvironment::default(),
            None,
        )
        .await
        .unwrap()
        .session
}

fn starts_of(path: &std::path::Path, conversation: &str) -> usize {
    let expected = format!("resume {conversation}");
    fs::read_to_string(path)
        .unwrap()
        .lines()
        .filter(|line| *line == expected)
        .count()
}

fn agent_ids(report: &Value, list: &str) -> Vec<String> {
    let mut ids: Vec<String> = report[list]
        .as_array()
        .unwrap_or_else(|| panic!("{list} is missing: {report}"))
        .iter()
        .map(|entry| entry["agentId"].as_str().unwrap().to_owned())
        .collect();
    ids.sort();
    ids
}

#[tokio::test]
#[ignore = "requires isolated real Hmux; use scripts/qa/hmux-control-plane-smoke.mjs"]
async fn resume_all_restores_each_agent_after_its_host_ends() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    let starts = root.path().join("provider-starts");
    let provider = root.path().join("codex-fixture");
    fs::write(
        &provider,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\nexec sleep 120\n",
            starts.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&provider, fs::Permissions::from_mode(0o700)).unwrap();
    let hmux = RealHmux::install(root, &mut state);
    make_fixture_mutation_authority(&mut state);

    let mut gone = Vec::new();
    for name in ["alpha", "beta", "gamma"] {
        let agent = AgentIdV1::new(format!("resume-all-{name}")).unwrap();
        let conversation = format!("conversation-{name}");
        let source = launch_restorable(&state, &hmux, &conversation).await;
        bind_source_conversation(&state, &agent, &source, Some(&conversation)).await;
        gone.push((agent, conversation, source));
    }
    let running_agent = AgentIdV1::new("resume-all-running").unwrap();
    let running = launch_restorable(&state, &hmux, "conversation-running").await;
    bind_source_conversation(
        &state,
        &running_agent,
        &running,
        Some("conversation-running"),
    )
    .await;
    let hung_agent = AgentIdV1::new("resume-all-hung").unwrap();
    let hung = launch_restorable(&state, &hmux, "conversation-hung").await;
    bind_source_conversation(&state, &hung_agent, &hung, Some("conversation-hung")).await;
    let anonymous_agent = AgentIdV1::new("resume-all-anonymous").unwrap();
    let anonymous = launch_conversation(&state, &hmux, "resume-all-anonymous", None).await;
    bind_source_conversation(&state, &anonymous_agent, &anonymous, None).await;
    wait_for_provider_starts(&starts, 6).await;

    let registry = json!({"agents": [
        {"id": "resume-all-alpha", "name": "alpha"}, {"id": "resume-all-beta", "name": "beta"},
        {"id": "resume-all-gamma", "name": "gamma"}, {"id": "resume-all-running", "name": "running"},
        {"id": "resume-all-hung", "name": "hung"}, {"id": "resume-all-anonymous", "name": "anonymous"},
    ]});
    let runtime = state.hmux_identity.runtime_executable_path.clone();
    let state = publication_state(state);
    let _server = PublicationServer::start(Arc::clone(&state));

    // End every Host the way a power loss does: no tombstone, no goodbye.
    for session in gone.iter().map(|(_, _, source)| source).chain([&anonymous]) {
        let descriptor = hmux.session(session);
        signal(descriptor.host_process.process_id, "-KILL");
        RealHmux::assert_exited(&descriptor).await;
    }
    // A hung Host stops answering but owns its socket. It must survive.
    let hung_descriptor = hmux.session(&hung);
    signal(hung_descriptor.host_process.process_id, "-STOP");

    let args = ["resume", "--all", "--backend", "fixture", "--json"];
    let (ok, dry_run) = run_cli(
        &state,
        &hmux.root,
        &[
            "resume",
            "--all",
            "--dry-run",
            "--backend",
            "fixture",
            "--json",
        ],
        Some(registry.clone()),
        Some(&runtime),
    )
    .await;
    assert!(ok, "{dry_run}");
    let restorable = agent_ids(&dry_run, "restorable");
    for (agent, _, _) in &gone {
        assert!(restorable.contains(&agent.as_str().to_owned()), "{dry_run}");
    }
    assert_eq!(fs::read_to_string(&starts).unwrap().lines().count(), 6);

    let (ok, report) = run_cli(
        &state,
        &hmux.root,
        &args,
        Some(registry.clone()),
        Some(&runtime),
    )
    .await;
    signal(hung_descriptor.host_process.process_id, "-CONT");
    assert!(ok, "{report}");
    assert_eq!(
        agent_ids(&report, "restored"),
        ["resume-all-alpha", "resume-all-beta", "resume-all-gamma"],
        "{report}"
    );
    assert_eq!(
        agent_ids(&report, "alreadyRunning"),
        ["resume-all-running"],
        "{report}"
    );
    assert_eq!(report["failed"], json!([]), "{report}");
    let skipped: std::collections::BTreeMap<_, _> = report["skipped"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            (
                entry["agentId"].as_str().unwrap().to_owned(),
                entry["reason"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    assert_eq!(
        skipped["resume-all-anonymous"], "no_conversation_id",
        "{report}"
    );
    // Either the Host-absence fence refused it or its probe could not finish.
    assert!(
        ["host_still_running", "host_state_unknown"].contains(&skipped["resume-all-hung"].as_str()),
        "{report}"
    );

    wait_for_provider_starts(&starts, 9).await;
    for (agent, conversation, source) in &gone {
        assert_eq!(
            starts_of(&starts, conversation),
            2,
            "{conversation} resumes once"
        );
        let entry = report["restored"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["agentId"] == agent.as_str())
            .unwrap();
        assert_eq!(entry["conversationId"], conversation.as_str());
        let session_id = entry["sessionId"].as_str().unwrap();
        assert_ne!(session_id, source.session_id);
        let binding = state
            .store
            .agent_checkpoint_binding_authority(agent)
            .await
            .unwrap()
            .unwrap()
            .binding;
        assert_eq!(binding.session_id, session_id);
    }
    assert_eq!(starts_of(&starts, "conversation-running"), 1);
    assert_eq!(starts_of(&starts, "conversation-hung"), 1);
    assert_eq!(
        hmux_client::probe_local_process_generation(&hung_descriptor.host_process).unwrap(),
        hmux_client::LocalProcessGenerationStatus::Live,
        "the hung Host keeps running"
    );

    // Running it again finds nothing to do and starts nothing.
    let (ok, again) = run_cli(
        &state,
        &hmux.root,
        &args,
        Some(registry.clone()),
        Some(&runtime),
    )
    .await;
    assert!(ok, "{again}");
    assert_eq!(
        agent_ids(&again, "restored"),
        Vec::<String>::new(),
        "{again}"
    );
    assert!(
        agent_ids(&again, "alreadyRunning").contains(&"resume-all-alpha".to_owned()),
        "{again}"
    );
    assert_eq!(fs::read_to_string(&starts).unwrap().lines().count(), 9);
}
