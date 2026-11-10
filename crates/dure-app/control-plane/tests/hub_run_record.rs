//! The served hub leaves a durable run record that explains how it ended.

use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::net::UnixStream;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

fn write_owner_file(path: &Path, source: &[u8], executable: bool) {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(if executable { 0o700 } else { 0o600 })
        .open(path)
        .unwrap();
    file.write_all(source).unwrap();
}

fn descriptor(root: &Path) -> Option<Value> {
    serde_json::from_slice(&fs::read(root.join("backend/control-plane.json")).ok()?).ok()
}

fn start_hub(root: &Path, generation: Option<&str>, reason: &str) -> Child {
    start_hub_with(root, generation, reason, false)
}

fn start_hub_with(
    root: &Path,
    generation: Option<&str>,
    reason: &str,
    ignore_hangup: bool,
) -> Child {
    let hmux = root.join("hmux");
    let mut command = Command::new(env!("CARGO_BIN_EXE_dure-control-plane"));
    command
        .args(["serve", "--home"])
        .arg(root)
        .arg("--hmux-bin")
        .arg(&hmux)
        .arg("--hmux-runtime-bin")
        .arg(&hmux)
        .arg("--hmux-discovery-root")
        .arg(root.join("hmux-discovery"))
        .env("DURE_HUB_LAUNCH_REASON", reason)
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    if let Some(generation) = generation {
        command.args(["--expected-generation", generation]);
    }
    if ignore_hangup {
        unsafe {
            command.pre_exec(|| {
                if libc::signal(libc::SIGHUP, libc::SIG_IGN) == libc::SIG_ERR {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    let mut child = command.spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if descriptor(root).is_some_and(|descriptor| descriptor["processId"] == child.id()) {
            return child;
        }
        if let Some(status) = child.try_wait().unwrap() {
            panic!("hub exited before it was ready: {status}");
        }
        assert!(
            Instant::now() < deadline,
            "hub did not publish its descriptor"
        );
        thread::sleep(Duration::from_millis(20));
    }
}

fn run_records(root: &Path) -> Vec<(PathBuf, Value)> {
    let mut paths = fs::read_dir(root.join("backend/hub-runs"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect::<Vec<_>>();
    paths.sort();
    paths
        .into_iter()
        .map(|path| {
            let mode = fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o077, 0, "{} is owner-only", path.display());
            let record = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            (path, record)
        })
        .collect()
}

fn record_for(root: &Path, process_id: u32) -> Value {
    run_records(root)
        .into_iter()
        .map(|(_, record)| record)
        .find(|record| record["processId"] == process_id)
        .unwrap_or_else(|| panic!("no run record for pid {process_id}"))
}

fn kill(child: &Child, signal: libc::c_int) {
    assert_eq!(unsafe { libc::kill(child.id() as libc::pid_t, signal) }, 0);
}

fn request_shutdown(descriptor: &Value) {
    let mut stream = UnixStream::connect(descriptor["socketPath"].as_str().unwrap()).unwrap();
    let request = json!({
        "schemaVersion": 1,
        "apiVersion": "dure.backend-transport/v1",
        "kind": "dure.backend.request",
        "requestId": "hub-run-record-shutdown",
        "operation": "backend.shutdown",
        "expected": {
            "backendId": descriptor["backendId"],
            "generation": descriptor["generation"],
            "protocol": {
                "minimum": { "major": 1, "minor": 0 },
                "maximum": { "major": 1, "minor": 0 }
            },
            "requiredCapabilities": []
        },
        "body": { "schemaVersion": 2, "mode": "stop" }
    });
    stream.write_all(format!("{request}\n").as_bytes()).unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    let response: Value = serde_json::from_str(&response).unwrap();
    assert_eq!(response["result"]["status"], "stopping", "{response}");
}

#[test]
fn hub_runs_record_signal_unrecorded_and_shutdown_endings() {
    let temporary = tempfile::Builder::new()
        .prefix("dure-hub-runs-")
        .tempdir_in("/tmp")
        .unwrap();
    fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o700)).unwrap();
    let root = temporary.path();
    write_owner_file(&root.join("hmux"), b"#!/bin/sh\nexit 1\n", true);
    fs::create_dir(root.join("hmux-discovery")).unwrap();

    // A first start records why it was launched and by whom.
    let mut first = start_hub(root, None, "first_start");
    let generation = descriptor(root).unwrap()["generation"]
        .as_str()
        .unwrap()
        .to_owned();
    let started = record_for(root, first.id());
    assert_eq!(started["schemaVersion"], 1);
    assert_eq!(started["generation"], generation.as_str());
    assert_eq!(started["launch"]["reason"], "first_start");
    assert_eq!(started["launch"]["launcherProcessId"], std::process::id());
    assert!(started.get("exit").is_none());

    // SIGTERM still ends the hub by that signal, and the hub says so first.
    kill(&first, libc::SIGTERM);
    let status = first.wait().unwrap();
    assert_eq!(status.signal(), Some(libc::SIGTERM), "{status}");
    let signalled = record_for(root, first.id());
    assert_eq!(signalled["exit"]["cause"], "signal");
    assert_eq!(signalled["exit"]["signal"], "SIGTERM");
    assert!(signalled["exit"]["uptimeMs"].as_i64().unwrap() >= 0);

    // SIGKILL leaves no chance to write; the next hub records that.
    let mut killed = start_hub(root, Some(&generation), "restart_unreachable");
    assert_eq!(
        record_for(root, killed.id())["launch"]["reason"],
        "restart_unreachable"
    );
    kill(&killed, libc::SIGKILL);
    killed.wait().unwrap();
    assert!(record_for(root, killed.id()).get("exit").is_none());

    // A signal the hub inherited as ignored stays ignored.
    let mut successor = start_hub_with(root, Some(&generation), "restart_unreachable", true);
    kill(&successor, libc::SIGHUP);
    thread::sleep(Duration::from_millis(300));
    assert!(
        successor.try_wait().unwrap().is_none(),
        "SIGHUP stayed ignored"
    );

    let unrecorded = record_for(root, killed.id());
    assert_eq!(unrecorded["exit"]["cause"], "unrecorded");
    assert_eq!(unrecorded["exit"]["recordedByProcessId"], successor.id());
    assert_eq!(
        unrecorded["exit"]["uptimeMs"].as_i64().unwrap(),
        unrecorded["lastAliveAtMs"].as_i64().unwrap() - unrecorded["startedAtMs"].as_i64().unwrap()
    );
    assert_eq!(record_for(root, first.id())["exit"]["cause"], "signal");

    // A requested shutdown is a clean ending.
    request_shutdown(&descriptor(root).unwrap());
    assert!(successor.wait().unwrap().success());
    let stopped = record_for(root, successor.id());
    assert_eq!(stopped["exit"]["cause"], "shutdown", "{stopped}");
    assert!(stopped.get("lastPanic").is_none());
    assert_eq!(run_records(root).len(), 3);
}
