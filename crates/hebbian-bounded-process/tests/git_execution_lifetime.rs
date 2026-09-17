#![cfg(unix)]

use hebbian_bounded_process::{CommandSpec, run};
use std::fs::{self, File};
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

fn try_lock(file: &File) -> io::Result<bool> {
    // SAFETY: the File owns this descriptor throughout the syscall.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    if error.kind() == io::ErrorKind::WouldBlock {
        Ok(false)
    } else {
        Err(error)
    }
}

fn git(repository: &Path, arguments: &[&str]) {
    let mut command = CommandSpec::new("git");
    command
        .arg("-C")
        .arg(repository)
        .args(arguments)
        .clear_env()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .capture_stderr(true);
    let output = run(&command, Duration::from_secs(10), 64 * 1024).unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

struct Fixture {
    root: PathBuf,
    parent: Child,
}

impl Fixture {
    fn new(mode: &str) -> Self {
        // Parent loss deliberately orphans Git. Retain the tiny repository,
        // including on assertion failure, instead of deleting an active cwd.
        let root = tempfile::Builder::new()
            .prefix("dure-git-execution-lifetime-")
            .tempdir()
            .unwrap()
            .keep();
        let repository = root.join("repository");
        fs::create_dir(&repository).unwrap();
        fs::create_dir(root.join("execution-lease")).unwrap();
        git(&repository, &["init", "--template=", "-b", "main"]);
        git(
            &repository,
            &["config", "user.name", "Execution Lifetime Fixture"],
        );
        git(
            &repository,
            &["config", "user.email", "fixture@example.invalid"],
        );
        fs::write(repository.join("tracked"), b"base\n").unwrap();
        git(&repository, &["add", "tracked"]);
        git(&repository, &["commit", "--no-gpg-sign", "-m", "base"]);
        let hooks = root.join("hooks");
        fs::create_dir(&hooks).unwrap();
        let hook = hooks.join("post-checkout");
        fs::write(
            &hook,
            b"#!/bin/sh\nexec \"$DURE_GIT_LIFETIME_FIXTURE_EXE\" git-post-checkout\n",
        )
        .unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o700)).unwrap();
        git(
            &repository,
            &["config", "core.hooksPath", hooks.to_str().unwrap()],
        );
        let parent = Command::new(env!("CARGO_BIN_EXE_bounded-process-fixture"))
            .args(["git-parent-loss", mode])
            .arg(&root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        Self { root, parent }
    }

    fn wait_for(&self, name: &str) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !self.root.join(name).exists() {
            assert!(
                Instant::now() < deadline,
                "fixture {name} timed out: {}",
                self.root.display()
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::write(self.root.join("release"), b"release");
        if matches!(self.parent.try_wait(), Ok(None)) {
            let _ = self.parent.kill();
        }
        let _ = self.parent.wait();
        eprintln!(
            "retained isolated Git lifetime fixture: {}",
            self.root.display()
        );
    }
}

fn parent_loss(mode: &str, retained_by_git: bool) {
    let mut fixture = Fixture::new(mode);
    fixture.wait_for("hook-ready");
    assert!(fixture.parent.try_wait().unwrap().is_none());
    let observer = File::open(fixture.root.join("execution-lease")).unwrap();
    assert!(!try_lock(&observer).unwrap());
    assert!(!fixture.root.join("checkout/late-write").exists());

    // The owned Child handle identifies the fixture wrapper only. The actual
    // Git/hook has acknowledged entry and is still held at its own barrier.
    fixture.parent.kill().unwrap();
    fixture.parent.wait().unwrap();
    let acquired_after_parent_exit = try_lock(&observer).unwrap();
    assert_eq!(acquired_after_parent_exit, !retained_by_git);
    assert!(!fixture.root.join("checkout/late-write").exists());
    fs::write(fixture.root.join("release"), b"release").unwrap();
    fixture.wait_for("hook-finished");
    assert_eq!(
        fs::read(fixture.root.join("checkout/late-write")).unwrap(),
        b"original Git hook"
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    while !try_lock(&observer).unwrap() {
        assert!(
            Instant::now() < deadline,
            "original Git execution retained its lease"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    eprintln!(
        "{mode}: acquired_after_parent_exit={acquired_after_parent_exit}, \
         late_write_after_parent_exit=true, final_lease_acquired=true"
    );
}

#[test]
fn parent_only_lease_is_released_while_original_git_can_still_write() {
    parent_loss("parent-only", false);
}

#[test]
fn inherited_directory_lease_outlives_the_parent_until_original_git_finishes() {
    parent_loss("inherited", true);
}

#[test]
fn async_directory_lease_outlives_the_parent_until_original_git_finishes() {
    parent_loss("async-inherited", true);
}
