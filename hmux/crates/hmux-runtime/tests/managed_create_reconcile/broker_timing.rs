use super::*;

const SELECTOR: &str = "HMUX_BROKER_TIMING_REQUEST";

fn replacement_timing(
    selection: Option<&str>,
    blocked_sink: bool,
    prepare_target: bool,
) -> Option<serde_json::Value> {
    // Keep evidence available to the owned Hmux runner even if an assertion fails.
    let state = tempfile::tempdir().unwrap().keep();
    let discovery = state.join("discovery");
    let cwd = state.canonicalize().unwrap();
    let hold = state.join("hold-open");
    fs::write(&hold, b"1").unwrap();
    let request = ManagedCreateRequest::new(
        "timed-replacement",
        "timed-source",
        "timed-workspace",
        "fixture",
        PermissionMode::Default,
        &cwd,
        fixture_provider_command(),
        24,
        80,
    )
    .unwrap()
    .with_provider_state_environment(
        ProviderStateEnvironment::new(BTreeMap::from([(
            FIXTURE_STATE_DIR_ENV.into(),
            cwd.to_string_lossy().into_owned(),
        )]))
        .unwrap(),
    )
    .unwrap()
    .with_conversation_identity(
        ProviderConversationIdentitySeed::new("fixture", "private-conversation").unwrap(),
    )
    .unwrap()
    .with_required_managed_stop_request_version(
        hmux_client::MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION,
    )
    .unwrap();
    let creator = ManagedSessionCreator::new(env!("CARGO_BIN_EXE_hmux-runtime"))
        .with_discovery_root(&discovery);
    let source = creator.create(request.clone()).unwrap();
    if prepare_target {
        let target = hmux_client::managed_replacement_root_request(&request).unwrap();
        hmux_client::recovery_journal::managed_create_ledger::prepare_root_request(
            &discovery, &target,
        )
        .unwrap();
    }
    let timing_path = discovery.join(".diagnostics/runtime-v1/broker-timing.jsonl");
    if blocked_sink {
        fs::create_dir_all(&timing_path).unwrap();
    }
    let mut command = Command::new(env!("CARGO_BIN_EXE_hmux-runtime"));
    command
        .arg("--no-autostart")
        .arg(MANAGED_CREATE_ADVANCE_BROKER_SUBCOMMAND)
        .current_dir(&cwd)
        .env(hmux_client::DISCOVERY_ROOT_ENV, &discovery)
        .env_remove(hmux_client::MANAGED_REHOST_SOURCE_DISCOVERY_ROOT_ENV)
        .env_remove(SELECTOR)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    if let Some(selection) = selection {
        command.env(SELECTOR, selection);
    }
    let mut broker = command.spawn().unwrap();
    write_json_frame(
        broker.stdin.as_mut().unwrap(),
        &ManagedCreateAdvanceRequest::replace_current(request.clone()).unwrap(),
    )
    .unwrap();
    drop(broker.stdin.take());
    let response: ManagedCreateAdvanceBrokerResponse =
        read_json_frame(broker.stdout.as_mut().unwrap()).unwrap();
    let status = broker.wait().unwrap();
    // Release the disposable providers before checking diagnostic expectations.
    fs::remove_file(&hold).unwrap();
    let ManagedCreateAdvanceBrokerResponse::Advanced(target) = response else {
        panic!("diagnostics changed replacement outcome: {response:?}");
    };
    wait_for_exited(&discovery, request.workspace_id(), request.session_id());
    wait_for_exited(&discovery, target.workspace_id(), target.session_id());
    assert!(status.success());
    assert_ne!(target.session_id(), request.session_id());
    assert_ne!(
        target.generation_fence(),
        source.receipt().generation_fence()
    );
    if blocked_sink {
        assert!(
            timing_path.is_dir(),
            "diagnostics replaced an unsafe destination"
        );
        return None;
    }
    let Ok(raw) = fs::read_to_string(&timing_path) else {
        return None;
    };
    assert_eq!(
        raw.lines().count(),
        1,
        "one record per selected broker request"
    );
    assert!(raw.len() <= 4096);
    assert_eq!(
        fs::metadata(&timing_path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    for private in [
        "private-conversation",
        FIXTURE_STATE_DIR_ENV,
        "capability",
        "command",
        "environment",
        cwd.to_str().unwrap(),
    ] {
        assert!(!raw.contains(private), "diagnostic leaked {private}");
    }
    Some(serde_json::from_str(&raw).unwrap())
}

#[test]
fn broker_timing_selected_request_records_real_replacement_stages() {
    assert_replacement_stages(false);
    assert_replacement_stages(true);
}

fn assert_replacement_stages(prepare_target: bool) {
    let record = replacement_timing(Some("timed-replacement"), false, prepare_target)
        .expect("selected broker request did not emit its stage timings");
    assert_eq!(record["schemaVersion"], 1);
    assert_eq!(record["requestId"], "timed-replacement");
    assert_eq!(record["sessionId"], "timed-source");
    assert_eq!(record["workspaceId"], "timed-workspace");
    assert_eq!(record["outcome"], "advanced");
    assert_eq!(record["responsePublished"], true);
    assert_eq!(record["truncated"], false);
    let phases = record["phases"].as_array().unwrap();
    let launches = phases
        .iter()
        .filter(|phase| phase["phase"] == "target_launch")
        .collect::<Vec<_>>();
    assert_eq!(
        launches.len(),
        2,
        "writer conflict followed by exact replacement"
    );
    for name in [
        "launch_capacity",
        "launch_compatibility",
        "launch_admission",
    ] {
        let stages = phases
            .iter()
            .filter(|phase| phase["phase"] == name)
            .collect::<Vec<_>>();
        // An unprepared root also enters ordinary advance after the first
        // writer conflict. A resource-prepared root returns that conflict
        // directly, as in the native app's replacement path.
        let expected_attempts = [if prepare_target { 1 } else { 2 }, 1];
        assert_eq!(
            stages.len(),
            expected_attempts.iter().sum::<usize>(),
            "missing {name}: {record}"
        );
        for (launch, expected) in launches.iter().zip(expected_attempts) {
            let launch_start = launch["startMicros"].as_u64().unwrap();
            let launch_end = launch_start + launch["elapsedMicros"].as_u64().unwrap();
            assert_eq!(
                stages
                    .iter()
                    .filter(|stage| {
                        let start = stage["startMicros"].as_u64().unwrap();
                        let end = start + stage["elapsedMicros"].as_u64().unwrap();
                        start >= launch_start && end <= launch_end
                    })
                    .count(),
                expected,
                "{name} attempts outside their target launch: {record}"
            );
        }
    }
    eprintln!("replacement launch-stage trace: {record}");
    for name in [
        "replacement_reservation",
        "source_close",
        "stop_reconcile",
        "stop_reservation",
        "target_launch",
        "replacement_completion",
        "response_publish",
    ] {
        let phase = phases
            .iter()
            .find(|phase| phase["phase"] == name)
            .unwrap_or_else(|| panic!("missing {name}: {record}"));
        assert!(phase["elapsedMicros"].is_u64());
        if name == "replacement_reservation" {
            for field in [
                "maintenanceAcquireMicros",
                "admissionLockMicros",
                "metadataScanMicros",
                "operationLockMicros",
                "recordPublishMicros",
            ] {
                assert!(
                    phase["reservation"][field].is_u64(),
                    "missing {field}: {phase}"
                );
            }
        }
    }
    assert_eq!(phases.last().unwrap()["phase"], "response_publish");
    let total = record["elapsedMicros"].as_u64().unwrap();
    for phase in phases {
        assert!(
            phase["startMicros"].as_u64().unwrap() + phase["elapsedMicros"].as_u64().unwrap()
                <= total
        );
    }
}

#[test]
fn broker_timing_absent_or_other_request_does_not_emit() {
    assert!(replacement_timing(None, false, false).is_none());
    assert!(replacement_timing(Some("another-request"), false, true).is_none());
}

#[test]
fn broker_timing_unwritable_sink_does_not_fail_replacement() {
    assert!(replacement_timing(Some("timed-replacement"), true, true).is_none());
}
