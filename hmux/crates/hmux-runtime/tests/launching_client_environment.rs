#![cfg(unix)]

use hmux_client::{
    LocalProcessGenerationStatus, LocalSession, LocalSessionCatalog, ManagedCreateOutcome,
    ManagedCreateRequest, ManagedSessionCreator, ManagedSessionStopper, ManagedStopOutcome,
    ManagedStopRequest, PermissionMode, StandaloneCreateRequest, StandaloneSessionCreator,
    TerminalEnvironment, probe_local_process_generation,
};
use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

const MARKERS: [&str; 8] = [
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CODEX_SESSION_ID",
    "CODEX_THREAD_ID",
];

#[test]
fn managed_host_and_provider_isolate_the_launching_client_environment() {
    verify_spawn(true, false);
}

#[test]
fn standalone_host_and_provider_isolate_the_launching_client_environment() {
    verify_spawn(false, false);
}

#[test]
fn explicit_session_environment_survives_ambient_marker_isolation() {
    verify_spawn(true, true);
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn fixture_runtime(root: &Path) -> PathBuf {
    let runtime = root.join("runtime");
    let mut environment = vec![
        format!("HOME={}", root.display()),
        format!("TMPDIR={}", root.display()),
        format!("HMUX_DISCOVERY_ROOT={}/discovery", root.display()),
        "PATH=/usr/bin:/bin".into(),
        "CLAUDE_CODE_OAUTH_TOKEN=synthetic-auth".into(),
        "CLAUDE_CODE_USE_BEDROCK=synthetic-routing".into(),
        "CLAUDE_CODE_MAX_OUTPUT_TOKENS=synthetic-output-limit".into(),
        "CLAUDE_CONFIG_DIR=synthetic-profile".into(),
        "CODEX_HOME=synthetic-codex-profile".into(),
        "USER_TOOL_SETTING=synthetic-setting".into(),
    ];
    environment.extend(MARKERS.map(|key| format!("{key}=synthetic-parent")));
    // Start from an empty environment so observing the Host cannot expose the
    // test runner's user credentials or another Agent's session metadata.
    let command = format!(
        "#!/bin/sh\nexec /usr/bin/env -i {} {} \"$@\"\n",
        environment
            .iter()
            .map(|entry| quote(entry))
            .collect::<Vec<_>>()
            .join(" "),
        quote(env!("CARGO_BIN_EXE_hmux-runtime")),
    );
    fs::write(&runtime, command).unwrap();
    fs::set_permissions(&runtime, fs::Permissions::from_mode(0o700)).unwrap();
    runtime
}

fn verify_spawn(managed: bool, explicit: bool) {
    // The enclosing Hmux test guardian owns final directory reclamation. Keep
    // fixture evidence if a failed launch never yields an exact stop fence.
    let root = tempfile::tempdir().unwrap().keep();
    let runtime = fixture_runtime(&root);
    let discovery = root.join("discovery");
    let output = root.join("provider-environment");
    let starts = root.join("provider-starts");
    let provider = root.join("provider.sh");
    fs::write(
        &provider,
        "#!/bin/sh\numask 077\nprintf x >> \"$2\"\nenv > \"$1.tmp\"\nmv \"$1.tmp\" \"$1\"\nprintf 'environment-ready\\n'\nwhile IFS= read -r line; do printf 'observed:%s\\n' \"$line\"; done\n",
    ).unwrap();
    let command = vec![
        "/bin/sh".into(),
        provider.to_string_lossy().into_owned(),
        output.to_string_lossy().into_owned(),
        starts.to_string_lossy().into_owned(),
    ];
    let overrides = if explicit {
        TerminalEnvironment::new(BTreeMap::from([
            ("TERM".into(), Some("screen-256color".into())),
            ("NO_COLOR".into(), Some("session-explicit".into())),
        ]))
        .unwrap()
    } else {
        TerminalEnvironment::default()
    };
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
    .with_terminal_environment(overrides.clone())
    .unwrap();
    let creator = ManagedSessionCreator::new(&runtime).with_discovery_root(&discovery);
    let session = if managed {
        creator.create(request.clone()).unwrap().session().clone()
    } else {
        StandaloneSessionCreator::new(&runtime)
            .with_discovery_root(&discovery)
            .create(
                StandaloneCreateRequest::new(&root, Some("environment".into()), command, 24, 80)
                    .unwrap()
                    .with_terminal_environment(overrides)
                    .unwrap(),
            )
            .unwrap()
            .session()
            .clone()
    };

    let observations = std::panic::catch_unwind(|| {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !output.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        let provider_environment = fs::read_to_string(&output).unwrap();
        let host = &session.descriptor().host_process;
        assert_eq!(
            probe_local_process_generation(host).unwrap(),
            LocalProcessGenerationStatus::Live
        );
        let environment = Command::new("/bin/ps")
            .args(["eww", "-p", &host.process_id.to_string(), "-o", "command="])
            .output()
            .unwrap();
        assert!(environment.status.success());
        assert_eq!(
            probe_local_process_generation(host).unwrap(),
            LocalProcessGenerationStatus::Live
        );
        let host_environment = String::from_utf8(environment.stdout).unwrap();

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
        // Fresh observer connections exercise detach/reattach without creating
        // another provider or changing the existing environment.
        session.read_screen(None).unwrap();
        session.read_screen(None).unwrap();
        assert_eq!(fs::read(&starts).unwrap(), b"x");
        (host_environment, provider_environment)
    });

    stop_fixture(&runtime, &root, &discovery, &session, managed);
    let (host, provider) = observations.unwrap();
    let host_leaks = MARKERS
        .into_iter()
        .filter(|key| host.contains(&format!("{key}=synthetic-parent")))
        .collect::<Vec<_>>();
    let provider_leaks = MARKERS
        .into_iter()
        .filter(|key| {
            provider
                .lines()
                .any(|line| line == format!("{key}=synthetic-parent"))
        })
        .collect::<Vec<_>>();
    let missing_configuration = [
        "CLAUDE_CODE_OAUTH_TOKEN=synthetic-auth",
        "CLAUDE_CODE_USE_BEDROCK=synthetic-routing",
        "CLAUDE_CODE_MAX_OUTPUT_TOKENS=synthetic-output-limit",
        "CLAUDE_CONFIG_DIR=synthetic-profile",
        "CODEX_HOME=synthetic-codex-profile",
        "USER_TOOL_SETTING=synthetic-setting",
    ]
    .into_iter()
    .filter(|entry| !host.contains(entry) || !provider.lines().any(|line| line == *entry))
    .collect::<Vec<_>>();
    assert!(
        host_leaks.is_empty() && provider_leaks.is_empty() && missing_configuration.is_empty(),
        "Host marker keys={host_leaks:?}; provider marker keys={provider_leaks:?}; missing synthetic configuration={missing_configuration:?}",
    );
    if explicit {
        assert!(provider.lines().any(|line| line == "TERM=screen-256color"));
        assert!(
            provider
                .lines()
                .any(|line| line == "NO_COLOR=session-explicit")
        );
    }
}

fn stop_fixture(
    runtime: &Path,
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
    let deadline = Instant::now() + Duration::from_secs(5);
    for process in [&descriptor.provider_process, &descriptor.host_process] {
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
