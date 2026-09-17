use super::*;
use std::os::unix::fs::PermissionsExt;
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};

const ROOT_ENV: &str = "DURE_CHECKOUT_STATE_FIXTURE_ROOT";

fn admit(root: &Path) -> Result<AdmittedGitCheckoutCreation, GitCheckoutUseError> {
    prepare_git_checkout_creation(
        &root.join("repository"),
        &root.join("creation-target"),
        &operation("held-abort-owner"),
        &["HEAD"],
    )?
    .ok_or_else(|| phase_conflict("expected original creation"))?
    .admit()
}

#[test]
fn creation_abort_child() {
    let Some(root) = std::env::var_os(ROOT_ENV) else {
        return;
    };
    let root = PathBuf::from(root);
    let creation = admit(&root).unwrap();
    fs::write(root.join("abort-pending"), b"pending").unwrap();
    creation.abort_if_absent().unwrap();
}

struct ChildFixture {
    root: PathBuf,
    child: Child,
}

impl Drop for ChildFixture {
    fn drop(&mut self) {
        let _ = fs::write(self.root.join("release-abort"), b"release");
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
        eprintln!(
            "retained isolated checkout-state fixture: {}",
            self.root.display()
        );
    }
}

#[test]
fn parent_loss_cannot_resume_creation_ahead_of_its_pending_abort_commit() {
    let fixture = fixture();
    let root = fs::canonicalize(fixture._temporary.keep()).unwrap();
    let tools = root.join("tools");
    fs::create_dir(&tools).unwrap();
    let real_git = Command::new("sh")
        .args(["-c", "command -v git"])
        .output()
        .unwrap();
    assert!(real_git.status.success());
    let real_git = String::from_utf8(real_git.stdout)
        .unwrap()
        .trim()
        .to_owned();
    assert!(Path::new(&real_git).is_absolute());
    let wrapper = tools.join("git");
    fs::write(
        &wrapper,
        br##"#!/bin/sh
root="$DURE_CHECKOUT_STATE_FIXTURE_ROOT"
for argument do
  if [ "$argument" = update-ref ] && [ -f "$root/abort-pending" ]; then
    mv "$root/abort-pending" "$root/abort-ready"
    i=0
    while [ ! -f "$root/release-abort" ]; do
      i=$((i+1))
      [ "$i" -lt 1000 ] || exit 1
      sleep 0.01
    done
  fi
done
exec "$DURE_CHECKOUT_STATE_REAL_GIT" "$@"
"##,
    )
    .unwrap();
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o700)).unwrap();
    let path = std::env::join_paths(std::iter::once(tools).chain(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    )))
    .unwrap();
    let child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "authority::tests::creation_commit_tests::creation_abort_child",
            "--nocapture",
        ])
        .env(ROOT_ENV, &root)
        .env("DURE_CHECKOUT_STATE_REAL_GIT", real_git)
        .env("PATH", path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .unwrap();
    let mut fixture = ChildFixture { root, child };
    let deadline = Instant::now() + Duration::from_secs(10);
    while !fixture.root.join("abort-ready").exists() {
        assert!(
            fixture.child.try_wait().unwrap().is_none(),
            "creator exited before abort commit"
        );
        assert!(
            Instant::now() < deadline,
            "abort commit did not enter barrier"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(fixture.child.try_wait().unwrap().is_none());
    fixture.child.kill().unwrap();
    fixture.child.wait().unwrap();
    let root = fixture.root.clone();
    let (finished, completion) = std::sync::mpsc::channel();
    let recovery = std::thread::spawn(move || {
        let result = admit(&root).map(drop);
        finished.send(result).unwrap();
    });
    let early = completion.recv_timeout(Duration::from_millis(200));
    fs::write(fixture.root.join("release-abort"), b"release").unwrap();
    recovery.join().unwrap();
    assert!(
        matches!(early, Err(std::sync::mpsc::RecvTimeoutError::Timeout)),
        "creation resumed while its original abort could still commit: {early:?}"
    );
    let result = completion.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(result.unwrap_err().code, "checkout_use_phase_conflict");
    assert!(!fixture.root.join("creation-target").exists());
}
