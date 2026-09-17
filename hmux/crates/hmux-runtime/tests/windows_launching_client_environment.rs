#![cfg(windows)]

use hmux_client::{
    LocalProcessGenerationStatus, LocalSession, LocalSessionCatalog, ManagedCreateOutcome,
    ManagedCreateRequest, ManagedSessionCreator, ManagedSessionStopper, ManagedStopOutcome,
    ManagedStopRequest, PermissionMode, StandaloneCreateRequest, StandaloneSessionCreator,
    TerminalEnvironment, probe_local_process_generation,
};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

const FIXTURE_ROOT: &str = "HMUX_CLIENT_ENVIRONMENT_FIXTURE_ROOT";
const FIXTURE_MODE: &str = "HMUX_CLIENT_ENVIRONMENT_FIXTURE_MODE";
const MARKERS: [&str; 8] = [
    "ClaudeCode",
    "Claude_Code_Entrypoint",
    "Claude_Code_Child_Session",
    "Claude_Code_Session_Id",
    "Claude_Code_Messaging_Socket",
    "Claude_Code_Messaging_Token",
    "Codex_Session_Id",
    "Codex_Thread_Id",
];
const CONFIGURATION: [(&str, &str); 6] = [
    ("Claude_Code_Oauth_Token", "synthetic-auth"),
    ("Claude_Code_Use_Bedrock", "synthetic-routing"),
    ("Claude_Code_Max_Output_Tokens", "synthetic-output-limit"),
    ("Claude_Config_Dir", "synthetic-profile"),
    ("Codex_Home", "synthetic-codex-profile"),
    ("User_Tool_Setting", "synthetic-setting"),
];

#[test]
fn managed_windows_session_isolates_mixed_case_parent_markers() {
    run_isolated_parent("managed");
}

#[test]
fn standalone_windows_session_isolates_mixed_case_parent_markers() {
    run_isolated_parent("standalone");
}

#[test]
fn windows_session_preserves_explicit_terminal_environment() {
    run_isolated_parent("explicit");
}

fn run_isolated_parent(mode: &str) {
    let state = std::env::var_os("DURE_HMUX_TEST_STATE_ROOT")
        .expect("run native environment QA through hmux-native-windows-smoke.mjs");
    let state = Path::new(&state).canonicalize().unwrap();
    // The enclosing native Job owns descendants; retain failed launch evidence.
    let root = tempfile::Builder::new()
        .prefix("windows-client-environment-")
        .tempdir_in(&state)
        .unwrap()
        .keep();
    let home = root.join("home");
    let temporary = root.join("tmp");
    for directory in [&home, &temporary] {
        fs::create_dir(directory).unwrap();
    }
    let system = std::env::var_os("SystemRoot").expect("native Windows SystemRoot");
    let mut child = Command::new(std::env::current_exe().unwrap());
    // Isolate the actual caller, not just a model of the environment policy.
    // No credentials or other agent's markers enter the observable fixture.
    child
        .args([
            "--ignored",
            "--exact",
            "environment_fixture_parent",
            "--nocapture",
        ])
        .current_dir(&root)
        .env_clear()
        .env("SystemRoot", &system)
        .env("WINDIR", &system)
        .env("PATH", Path::new(&system).join("System32"))
        .env("ComSpec", Path::new(&system).join("System32/cmd.exe"))
        .env("USERPROFILE", &home)
        .env("HOME", &home)
        .env("APPDATA", home.join("AppData/Roaming"))
        .env("LOCALAPPDATA", home.join("AppData/Local"))
        .env("DURE_HOME", root.join("dure"))
        .env("TEMP", &temporary)
        .env("TMP", &temporary)
        .env("HMUX_DISCOVERY_ROOT", root.join("discovery"))
        .env(FIXTURE_ROOT, &root)
        .env(FIXTURE_MODE, mode)
        .env("NO_COLOR", "ambient-no-color")
        .envs(MARKERS.map(|key| (key, "synthetic-parent")))
        .envs(CONFIGURATION);
    let status = child.status().unwrap();
    assert!(
        status.success(),
        "native Windows environment case {mode} failed"
    );
}

#[test]
#[ignore = "executed only by the isolated environment test parent"]
fn environment_fixture_provider() {
    let root = std::env::var_os(FIXTURE_ROOT).expect("owned fixture root");
    let root = Path::new(&root);
    // Persist only selected synthetic observations, never the whole environment.
    let marker_keys = MARKERS
        .iter()
        .filter(|key| std::env::var_os(key).is_some())
        .copied()
        .collect::<Vec<_>>();
    let missing_configuration = CONFIGURATION
        .iter()
        .filter(|(key, value)| std::env::var(key).as_deref() != Ok(*value))
        .map(|(key, _)| *key)
        .collect::<Vec<_>>();
    let observation = serde_json::json!({
        "markerKeys": marker_keys,
        "missingConfiguration": missing_configuration,
        "term": std::env::var("TERM").ok(),
        "noColor": std::env::var("NO_COLOR").ok(),
        "pid": std::process::id(),
    });
    let mut starts = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("provider-starts"))
        .unwrap();
    std::io::Write::write_all(&mut starts, b"x").unwrap();
    fs::write(
        root.join("observation.tmp"),
        serde_json::to_vec(&observation).unwrap(),
    )
    .unwrap();
    fs::rename(root.join("observation.tmp"), root.join("observation.json")).unwrap();
    println!("environment-ready");
    let mut line = String::new();
    while std::io::stdin().read_line(&mut line).unwrap() != 0 {
        line.clear();
    }
}

#[test]
#[ignore = "executed with an empty, synthetic-only caller environment"]
fn environment_fixture_parent() {
    let root = std::env::var_os(FIXTURE_ROOT).expect("owned fixture root");
    let root = Path::new(&root).canonicalize().unwrap();
    let mode = std::env::var(FIXTURE_MODE).unwrap();
    assert!(matches!(
        mode.as_str(),
        "managed" | "standalone" | "explicit"
    ));
    for key in MARKERS {
        assert_eq!(std::env::var(key).as_deref(), Ok("synthetic-parent"));
    }
    let runtime = env!("CARGO_BIN_EXE_hmux-runtime");
    let discovery = root.join("discovery");
    let managed = mode != "standalone";
    let terminal = if mode == "explicit" {
        TerminalEnvironment::new(BTreeMap::from([
            ("TERM".into(), Some("screen-256color".into())),
            ("NO_COLOR".into(), Some("session-explicit".into())),
        ]))
        .unwrap()
    } else {
        TerminalEnvironment::default()
    };
    let command = vec![
        std::env::current_exe()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
        "--ignored".into(),
        "--exact".into(),
        "environment_fixture_provider".into(),
        "--nocapture".into(),
    ];
    let request = ManagedCreateRequest::new(
        "environment-create",
        "environment-session",
        "environment-workspace",
        "fixture",
        PermissionMode::Default,
        &root,
        command.clone(),
        24,
        80,
    )
    .unwrap()
    .with_terminal_environment(terminal.clone())
    .unwrap();
    let creator = ManagedSessionCreator::new(runtime).with_discovery_root(&discovery);
    let session = if managed {
        creator.create(request.clone()).unwrap().session().clone()
    } else {
        StandaloneSessionCreator::new(runtime)
            .with_discovery_root(&discovery)
            .create(
                StandaloneCreateRequest::new(&root, Some("environment".into()), command, 24, 80)
                    .unwrap()
                    .with_terminal_environment(terminal)
                    .unwrap(),
            )
            .unwrap()
            .session()
            .clone()
    };
    let observations = std::panic::catch_unwind(|| {
        let output = root.join("observation.json");
        let deadline = Instant::now() + Duration::from_secs(5);
        while !output.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        let observation: serde_json::Value =
            serde_json::from_slice(&fs::read(output).unwrap()).unwrap();
        assert_eq!(
            observation["pid"],
            session.descriptor().provider_process.process_id
        );
        assert_eq!(
            probe_local_process_generation(&session.descriptor().host_process).unwrap(),
            LocalProcessGenerationStatus::Live
        );
        if managed {
            let replay = creator.create(request).unwrap();
            assert_eq!(replay.receipt().outcome(), ManagedCreateOutcome::Reused);
            assert!(
                replay
                    .session()
                    .descriptor()
                    .same_generation(session.descriptor())
            );
        }
        session.read_screen(None).unwrap();
        session.read_screen(None).unwrap();
        assert_eq!(fs::read(root.join("provider-starts")).unwrap(), b"x");
        observation
    });
    stop_fixture(runtime, &root, &discovery, &session, managed);
    let observation = observations.unwrap();
    println!("native-windows-environment {mode}: {observation}");
    assert_eq!(observation["markerKeys"], serde_json::json!([]));
    assert_eq!(observation["missingConfiguration"], serde_json::json!([]));
    if mode == "explicit" {
        assert_eq!(observation["term"], "screen-256color");
        assert_eq!(observation["noColor"], "session-explicit");
    } else {
        assert!(observation["noColor"].is_null());
    }
}

fn stop_fixture(
    runtime: &str,
    root: &Path,
    discovery: &Path,
    session: &LocalSession,
    managed: bool,
) {
    let descriptor = session.descriptor();
    if managed {
        let request = ManagedStopRequest::new(
            "environment-stop",
            &descriptor.session_id,
            &descriptor.workspace_id,
        )
        .unwrap()
        .with_expected_fence(
            &descriptor.runner_principal,
            &descriptor.runner_instance,
            descriptor.channel_epoch.parse().unwrap(),
            &descriptor.host_instance_id,
            &descriptor.terminal_epoch,
        )
        .unwrap();
        let stopped = ManagedSessionStopper::new(runtime, root)
            .with_discovery_root(discovery)
            .stop(request)
            .unwrap();
        assert_eq!(stopped.outcome(), ManagedStopOutcome::Stopped);
    } else {
        session
            .terminate_standalone(&LocalSessionCatalog::new(discovery), Duration::from_secs(5))
            .unwrap();
    }
    for process in [&descriptor.provider_process, &descriptor.host_process] {
        let deadline = Instant::now() + Duration::from_secs(5);
        while probe_local_process_generation(process).unwrap() == LocalProcessGenerationStatus::Live
            && Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(
            probe_local_process_generation(process).unwrap(),
            LocalProcessGenerationStatus::Absent
        );
    }
}
