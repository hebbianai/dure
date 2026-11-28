//! The managed Claude hook as Claude runs it: a non-zero exit is what Claude
//! shows as a failed hook. Each run has a disposable HOME and DURE_HOME, and
//! its report goes to an in-process fixture app, never a live one.
#![cfg(unix)]

use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    os::unix::fs::{DirBuilderExt, PermissionsExt},
    process::{Command, Output, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use serde_json::Value;

const TOKEN: &str = "fixture-report-token";
const GENERATION: &str = "fixture-generation";
/// Claude's own limit for the managed hook (`"timeout": 3`).
const CLAUDE_HOOK_TIMEOUT: Duration = Duration::from_secs(3);
/// Longer than any hook budget: an answer that never comes in time.
const NEVER: Duration = Duration::from_secs(30);
const FENCE: [(&str, &str); 7] = [
    ("HMUX_SESSION_ID", "fixture-session"),
    ("HMUX_WORKSPACE_ID", "fixture-workspace"),
    ("HMUX_RUNNER_PRINCIPAL", "fixture-principal"),
    ("HMUX_RUNNER_INSTANCE", "fixture-runner"),
    ("HMUX_CHANNEL_EPOCH", "1"),
    ("HMUX_HOST_INSTANCE_ID", "fixture-host"),
    ("HMUX_TERMINAL_EPOCH", "fixture-terminal"),
];

/// How the fixture app answers: its liveness check after `ping_delay`, and a
/// report, recorded as it arrives, with `status` and `body` after `delay`.
#[derive(Clone, Copy)]
struct Answers {
    ping_delay: Duration,
    status: u16,
    delay: Duration,
    body: &'static str,
}

const ACCEPTED: Answers = Answers {
    ping_delay: Duration::ZERO,
    status: 202,
    delay: Duration::ZERO,
    body: r#"{"ok":true,"accepted":true}"#,
};

struct App {
    port: u16,
    reports: Arc<Mutex<Vec<String>>>,
}

fn app(answers: Answers) -> App {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let reports = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&reports);
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let recorded = Arc::clone(&recorded);
            thread::spawn(move || serve(stream, answers, &recorded));
        }
    });
    App { port, reports }
}

/// A port nothing listens on, as for an app that is restarting or closed.
fn closed_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn serve(mut stream: TcpStream, answers: Answers, recorded: &Mutex<Vec<String>>) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut request = String::new();
    let mut length = 0;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
        if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            length = value.trim().parse().unwrap();
        }
        let end = line == "\r\n";
        request.push_str(&line);
        if end {
            break;
        }
    }
    let mut content = vec![0; length];
    if reader.read_exact(&mut content).is_err() {
        return;
    }
    let (status, answer) = if request.starts_with("GET /ping ") {
        thread::sleep(answers.ping_delay);
        let ping = serde_json::json!({
            "ok": true, "channel": "stable", "generation": GENERATION,
            "processId": std::process::id(),
            "capabilities": ["managed_claude_host_report_causality_v1"],
        });
        (200, ping.to_string())
    } else {
        assert!(request.starts_with("POST /hooks/claude "), "{request}");
        assert!(request.contains(&format!("authorization: Bearer {TOKEN}\r\n")));
        let report: Value = serde_json::from_slice(&content).unwrap();
        let event = report["hook_event_name"].as_str().unwrap().to_owned();
        recorded.lock().unwrap().push(event);
        thread::sleep(answers.delay);
        (answers.status, answers.body.to_owned())
    };
    let _ = write!(
        stream,
        "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{answer}",
        answer.len()
    );
}

/// Runs the hook once for a Stop. `published` is the port the app's
/// descriptor names, if any app was ever published; with `hold_input` stdin
/// is never closed, as if the caller never finished writing the event.
fn run_hook(published: Option<u16>, hold_input: bool) -> (Output, Duration) {
    let scope = tempfile::tempdir().unwrap();
    let (home, dure) = (scope.path().join("home"), scope.path().join("dure"));
    for directory in [&home, &dure] {
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(directory)
            .unwrap();
    }
    if let Some(port) = published {
        let descriptor = dure.join("server.json");
        let contents = serde_json::json!({
            "channel": "stable", "port": port, "processId": std::process::id(),
            "generation": GENERATION, "reportToken": TOKEN,
        });
        std::fs::write(&descriptor, contents.to_string()).unwrap();
        std::fs::set_permissions(&descriptor, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let started = Instant::now();
    let mut child = Command::new(env!("CARGO_BIN_EXE_dure-control-plane"))
        .arg("managed-claude-hook")
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", &home)
        .env("DURE_HOME", &dure)
        .env("HMUX_DISCOVERY_ROOT", scope.path().join("discovery"))
        .envs(FENCE)
        .current_dir(scope.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let held = if hold_input {
        Some(input)
    } else {
        let report = serde_json::json!({
            "hook_event_name": "Stop", "session_id": "fixture-conversation",
            "prompt_id": "fixture-prompt-0001", "background_tasks": [], "session_crons": [],
        });
        input.write_all(report.to_string().as_bytes()).unwrap();
        // Closing stdin ends the event, as Claude does.
        drop(input);
        None
    };
    let output = child.wait_with_output().unwrap();
    drop(held);
    (output, started.elapsed())
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

/// Claude sees no failed hook, and the stderr diagnostic names why.
fn assert_degraded(output: &Output, elapsed: Duration, code: &str) {
    assert!(output.status.success(), "{}", stderr(output));
    assert!(stderr(output).contains(code), "{}", stderr(output));
    assert!(output.stdout.is_empty());
    assert!(elapsed < CLAUDE_HOOK_TIMEOUT, "{elapsed:?}");
}

/// Claude shows a failed hook naming the misconfiguration.
fn assert_failed(output: &Output, elapsed: Duration, code: &str) {
    assert!(!output.status.success(), "{}", stderr(output));
    assert!(stderr(output).contains(code), "{}", stderr(output));
    assert!(elapsed < CLAUDE_HOOK_TIMEOUT, "{elapsed:?}");
}

#[test]
fn a_stop_the_app_confirms_too_late_is_not_a_failed_hook_and_the_app_holds_it() {
    // #822: a loaded app answered after the 2.4 s budget, and Claude showed
    // "Stop hook failed" for a report the app had already received.
    let app = app(Answers {
        delay: NEVER,
        ..ACCEPTED
    });
    let (output, elapsed) = run_hook(Some(app.port), false);
    assert_degraded(&output, elapsed, "managed_hook_report_timeout");
    assert_eq!(*app.reports.lock().unwrap(), ["Stop"]);
}

#[test]
fn an_app_whose_ping_never_answers_in_time_is_not_a_failed_hook() {
    // #822: on a machine at load ~500 the app was running but its liveness
    // check did not answer within the budget, and every hook failed.
    let app = app(Answers {
        ping_delay: NEVER,
        ..ACCEPTED
    });
    let (output, elapsed) = run_hook(Some(app.port), false);
    assert_degraded(&output, elapsed, "managed_hook_report_");
    assert!(app.reports.lock().unwrap().is_empty());
}

#[test]
fn an_app_that_is_restarting_is_not_a_failed_hook() {
    let (output, elapsed) = run_hook(Some(closed_port()), false);
    assert_degraded(&output, elapsed, "managed_hook_report_unavailable");
}

#[test]
fn a_report_the_app_refuses_is_still_a_failed_hook() {
    let app = app(Answers {
        status: 400,
        body: r#"{"ok":false,"error":{"code":"invalid_hook_report","message":"fixture"}}"#,
        ..ACCEPTED
    });
    let (output, elapsed) = run_hook(Some(app.port), false);
    assert_failed(
        &output,
        elapsed,
        "managed_hook_report_rejected: invalid_hook_report",
    );
}

#[test]
fn a_home_without_a_published_app_is_still_a_failed_hook() {
    let (output, elapsed) = run_hook(None, false);
    assert_failed(&output, elapsed, "managed_hook_app_not_found");
}

#[test]
fn input_that_never_arrives_is_still_a_failed_hook() {
    let app = app(ACCEPTED);
    let (output, elapsed) = run_hook(Some(app.port), true);
    assert_failed(&output, elapsed, "managed_hook_input_unavailable");
    assert!(app.reports.lock().unwrap().is_empty());
}
