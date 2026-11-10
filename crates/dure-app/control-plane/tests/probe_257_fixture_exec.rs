//! TEMPORARY PROBE for #257, removed before merge: how often does a freshly
//! written fixture fail to execute with ETXTBSY while other threads spawn
//! children, with an in-process writer versus a writer process?
#![cfg(target_os = "linux")]

use std::fs;
use std::io::Write as _;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;

fn in_process(path: &Path, script: &str) {
    fs::write(path, script).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}

fn writer_process(path: &Path, script: &str) {
    let status = Command::new("/bin/sh")
        .args([
            "-c",
            r#"umask 077 && printf '%s' "$1" > "$2""#,
            "write-fixture-executable",
        ])
        .arg(script)
        .arg(path)
        .status()
        .unwrap();
    assert!(status.success());
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
}

#[test]
fn probe_257_fixture_exec_under_concurrent_spawns() {
    let root = tempfile::tempdir().unwrap();
    let script = "#!/bin/sh\nexit 0\n";
    let iterations = 1500;
    let mut lines = String::new();
    for (label, write) in [
        ("fs::write", in_process as fn(&Path, &str)),
        ("writer process", writer_process),
    ] {
        let stop = Arc::new(AtomicBool::new(false));
        let spawners: Vec<_> = (0..6)
            .map(|index| {
                let stop = Arc::clone(&stop);
                thread::spawn(move || {
                    while !stop.load(Ordering::Relaxed) {
                        let mut command = Command::new("/bin/true");
                        if index % 2 == 1 {
                            // Forces fork + exec instead of posix_spawn, like
                            // the product's pre_exec and process-group spawns.
                            unsafe {
                                command.pre_exec(|| Ok(()));
                            }
                        }
                        let _ = command.status();
                    }
                })
            })
            .collect();
        let mut busy = 0;
        let mut other = Vec::new();
        for iteration in 0..iterations {
            let path = root
                .path()
                .join(format!("{}-{iteration}", label.replace([':', ' '], "-")));
            write(&path, script);
            match Command::new(&path).status() {
                Ok(status) => assert!(status.success()),
                Err(error) if error.raw_os_error() == Some(libc::ETXTBSY) => busy += 1,
                Err(error) => other.push(error.to_string()),
            }
        }
        stop.store(true, Ordering::Relaxed);
        for spawner in spawners {
            spawner.join().unwrap();
        }
        lines.push_str(&format!(
            "PROBE-257 {label}: {busy}/{iterations} launches failed with ETXTBSY; other errors: {other:?}\n"
        ));
    }
    let _ = std::io::stderr().write_all(lines.as_bytes());
}
