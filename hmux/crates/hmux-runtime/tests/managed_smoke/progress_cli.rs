//! Real Host progress through the shared observer and both CLI list adapters.

use super::*;

#[test]
#[ignore = "run pnpm test:hmux-rehost-cli progress with the isolated guardian and prepared CLI"]
fn list_and_inspect_preserve_the_same_host_progress() {
    let root = std::path::PathBuf::from(std::env::var_os("DURE_HMUX_TEST_STATE_ROOT").unwrap());
    let state = tempfile::tempdir_in(root).unwrap();
    let discovery = state.path().join("discovery");
    let hmux = std::env::var_os("DURE_QA_HMUX_BIN").unwrap();
    let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery)
        .create(rehostable_create_request(
            state.path(),
            &state.path().join("conversation"),
            "progress-list",
        ))
        .unwrap();
    let descriptor = created.session().descriptor().clone();
    let report = AgentStateReport {
        progress: Some(hmux_client::AgentProgressReport {
            source_id: "native-progress-fixture".into(),
            sequence: 1,
            phase: hmux_client::AgentProgressPhase::Thinking,
            turn_id: Some("turn-1".into()),
            message_turns: vec![],
        }),
        identity_only: false,
        activity: hmux_client::AgentRuntimeActivity::Working,
        attention: hmux_client::AgentRuntimeAttention::None,
        turn_completed: false,
        turn_completion_id: None,
        causality: None,
        working_ttl_ms: None,
        conversation_identity: None,
        expected_observation: None,
        background_work: false,
        startup_gate: None,
    };
    let reporter = ManagedAgentStateReporter::new(env!("CARGO_BIN_EXE_hmux-runtime"), state.path())
        .with_discovery_root(&discovery);
    assert_eq!(
        reporter
            .report_agent_state(
                ManagedAttachRequest::new(&descriptor.session_id, &descriptor.workspace_id)
                    .unwrap(),
                report,
            )
            .unwrap(),
        AgentStateReportOutcome::Applied,
    );

    let native = |args: &[&str]| {
        let output = Command::new(&hmux)
            .arg("--discovery-root")
            .arg(&discovery)
            .arg("--json")
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()
    };
    let show = native(&[
        "session",
        "show",
        &descriptor.session_id,
        "--workspace",
        &descriptor.workspace_id,
    ]);
    assert_eq!(
        show["agentRuntimeState"]["progress"]["report"]["phase"],
        "thinking"
    );
    let expected = &show["agentRuntimeState"]["progress"];
    // sessions.list on local and SSH backends invokes this same bounded native
    // list, with one shared observer budget instead of per-session show calls.
    let query = serde_json::json!({ "schemaVersion": 1, "maxItems": 128,
        "maxOutputBytes": 983040, "prioritized": [] })
    .to_string();
    let list = native(&[
        "session",
        "list",
        "--catalog-query-json",
        &query,
        "--probe-budget-ms",
        "1000",
    ]);
    assert_eq!(
        &list["sessions"][0]["agentRuntimeState"]["progress"],
        expected
    );
    let targets = serde_json::json!([{
        "sessionId": descriptor.session_id, "workspaceId": descriptor.workspace_id,
    }])
    .to_string();
    let batch = native(&[
        "session",
        "probe-batch",
        "--targets-json",
        &targets,
        "--include-runtime-state",
    ]);
    assert_eq!(
        &batch["results"][0]["agentRuntimeState"]["progress"],
        expected
    );
    assert_eq!(
        batch["results"][0]["terminalEpoch"],
        descriptor.terminal_epoch
    );
    assert_eq!(batch["results"][0]["outputSequence"], show["output_seq"]);
    let legacy = native(&["session", "probe-batch", "--targets-json", &targets]);
    assert!(legacy["results"][0].get("agentRuntimeState").is_none());
    let skipped = native(&[
        "session",
        "probe-batch",
        "--targets-json",
        &targets,
        "--include-runtime-state",
        "--probe-budget-ms",
        "0",
    ]);
    assert_eq!(skipped["results"][0]["liveness"], "unknown");
    assert!(skipped["results"][0].get("agentRuntimeState").is_none());

    let dure = |args: &[&str]| {
        let output = Command::new("node")
            .arg(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../cli/dure.mjs"))
            .args(args)
            .env("DURE_HOME", state.path().join("dure"))
            .env("DURE_APP_CHANNEL", "stable")
            .env("DURE_HMUX_BIN", &hmux)
            .env(hmux_client::DISCOVERY_ROOT_ENV, &discovery)
            .env_remove("DURE_BACKEND_PROFILE")
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        String::from_utf8(output.stdout).unwrap()
    };
    let list: serde_json::Value = serde_json::from_str(&dure(&["ls", "--json"])).unwrap();
    let show: serde_json::Value = serde_json::from_str(&dure(&[
        "inspect",
        &descriptor.session_id,
        "--workspace",
        &descriptor.workspace_id,
        "--json",
    ]))
    .unwrap();
    assert_eq!(
        &list["sessions"][0]["runtime"]["agentRuntimeState"]["progress"],
        expected
    );
    assert_eq!(
        list["sessions"][0]["runtime"]["agentRuntimeState"],
        show["session"]["runtime"]["agentRuntimeState"]
    );
    assert!(dure(&["ls"]).contains("thinking"));

    ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), state.path())
        .with_discovery_root(&discovery)
        .stop(exact_managed_stop_request(
            "stop-progress-list",
            &descriptor,
        ))
        .unwrap();
}

#[test]
#[ignore = "run pnpm test:hmux-rehost-cli idle with the isolated guardian and prepared CLI"]
fn list_and_inspect_report_how_long_a_quiet_agent_has_been_idle() {
    let root = std::path::PathBuf::from(std::env::var_os("DURE_HMUX_TEST_STATE_ROOT").unwrap());
    let state = tempfile::tempdir_in(root).unwrap();
    let discovery = state.path().join("discovery");
    let hmux = std::env::var_os("DURE_QA_HMUX_BIN").unwrap();
    let created = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery)
        .create(rehostable_create_request(
            state.path(),
            &state.path().join("conversation"),
            "idle-list",
        ))
        .unwrap();
    let descriptor = created.session().descriptor().clone();
    let reporter = ManagedAgentStateReporter::new(env!("CARGO_BIN_EXE_hmux-runtime"), state.path())
        .with_discovery_root(&discovery);
    assert!(matches!(
        reporter
            .report_agent_state(
                ManagedAttachRequest::new(&descriptor.session_id, &descriptor.workspace_id)
                    .unwrap(),
                AgentStateReport {
                    progress: None,
                    identity_only: false,
                    activity: hmux_client::AgentRuntimeActivity::Waiting,
                    attention: hmux_client::AgentRuntimeAttention::None,
                    turn_completed: false,
                    turn_completion_id: None,
                    causality: None,
                    working_ttl_ms: None,
                    conversation_identity: None,
                    expected_observation: None,
                    background_work: false,
                    startup_gate: None,
                },
            )
            .unwrap(),
        AgentStateReportOutcome::Applied | AgentStateReportOutcome::NoOp
    ));
    // Long enough that the text column shows a duration, not a fresh zero.
    std::thread::sleep(std::time::Duration::from_millis(1_100));

    let native = |args: &[&str]| {
        let output = Command::new(&hmux)
            .arg("--discovery-root")
            .arg(&discovery)
            .arg("--json")
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        serde_json::from_slice::<serde_json::Value>(&output.stdout).unwrap()
    };
    let age = |value: &serde_json::Value| -> u64 {
        value
            .as_str()
            .unwrap_or_else(|| panic!("semantic idle age must be a decimal string: {value}"))
            .parse()
            .unwrap()
    };
    let show = native(&[
        "session",
        "show",
        &descriptor.session_id,
        "--workspace",
        &descriptor.workspace_id,
    ]);
    assert_eq!(show["agentRuntimeState"]["activity"], "waiting");
    assert!(age(&show["semanticIdleMs"]) >= 1_000, "{show}");

    let targets = serde_json::json!([{
        "sessionId": descriptor.session_id, "workspaceId": descriptor.workspace_id,
    }])
    .to_string();
    let batch = native(&[
        "session",
        "probe-batch",
        "--targets-json",
        &targets,
        "--include-runtime-state",
        "--include-semantic-idle",
    ]);
    assert!(
        age(&batch["results"][0]["semanticIdleMs"]) >= 1_000,
        "{batch}"
    );
    // Readers that requested only the runtime state refuse unrequested keys.
    let runtime_only = native(&[
        "session",
        "probe-batch",
        "--targets-json",
        &targets,
        "--include-runtime-state",
    ]);
    assert!(
        runtime_only["results"][0].get("semanticIdleMs").is_none(),
        "{runtime_only}"
    );

    let dure = |args: &[&str]| {
        let output = Command::new("node")
            .arg(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../cli/dure.mjs"))
            .args(args)
            .env("DURE_HOME", state.path().join("dure"))
            .env("DURE_APP_CHANNEL", "stable")
            .env("DURE_HMUX_BIN", &hmux)
            .env(hmux_client::DISCOVERY_ROOT_ENV, &discovery)
            .env_remove("DURE_BACKEND_PROFILE")
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        String::from_utf8(output.stdout).unwrap()
    };
    let list: serde_json::Value = serde_json::from_str(&dure(&["ls", "--json"])).unwrap();
    let show: serde_json::Value = serde_json::from_str(&dure(&[
        "inspect",
        &descriptor.session_id,
        "--workspace",
        &descriptor.workspace_id,
        "--json",
    ]))
    .unwrap();
    for session in [&list["sessions"][0], &show["session"]] {
        let idle = age(&session["runtime"]["semanticIdleMs"]);
        assert!(idle >= 1_000, "{session}");
        assert_eq!(session["fieldSources"]["idleSinceMs"], "hmux_host");
        assert_eq!(
            session["idleSinceMs"].as_u64().unwrap(),
            session["liveness"]["observedAtMs"].as_u64().unwrap() - idle,
        );
    }
    let table = dure(&["ls"]);
    let mut lines = table.lines();
    let header: Vec<&str> = lines.next().unwrap().split('\t').collect();
    let row: Vec<&str> = lines.next().unwrap().split('\t').collect();
    let column = header.iter().position(|name| *name == "IDLE").unwrap();
    assert_ne!(row[column], "-", "{table}");

    ManagedSessionStopper::new(env!("CARGO_BIN_EXE_hmux-runtime"), state.path())
        .with_discovery_root(&discovery)
        .stop(exact_managed_stop_request("stop-idle-list", &descriptor))
        .unwrap();
}
