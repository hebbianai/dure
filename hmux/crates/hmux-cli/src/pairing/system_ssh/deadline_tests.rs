use super::*;
use std::os::unix::fs::PermissionsExt as _;

fn wrapper(script: &str) -> (tempfile::TempDir, SystemSsh) {
    let directory = tempfile::tempdir().unwrap();
    let program = directory.path().join("ssh-fixture");
    std::fs::write(&program, format!("#!/bin/sh\n{script}\n")).unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
    let ssh = SystemSsh {
        program: program.to_str().unwrap().into(),
        connect_timeout_seconds: 10,
    };
    (directory, ssh)
}

fn host() -> InventoryHost {
    InventoryHost {
        id: "owned-fixture".into(),
        name: "owned fixture".into(),
        host: "unused.invalid".into(),
        port: 22,
        user: "unused".into(),
        auth: "auto".into(),
        key_path: None,
        target: HostTarget::Remote(SshInvocation::Explicit),
    }
}

#[test]
fn authentication_cannot_reset_the_fleet_deadline_to_a_per_host_timeout() {
    let (_directory, ssh) = wrapper("exec sleep 2");
    let started = Instant::now();
    let result = ssh.run_authenticated(
        &host(),
        &["unused"],
        "public key\n",
        Some(started + Duration::from_millis(100)),
        |_| panic!("an unauthenticated connection must not be authorized"),
    );
    assert!(result.unwrap_err().contains("pairing_deadline_elapsed"));
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[test]
fn deadline_elapsed_during_identity_recording_withholds_mutation_input() {
    let (directory, ssh) = wrapper(
        r#"
while [ "$1" != "-E" ]; do shift; done
shift
printf '%s\n' \
  'debug1: Server host key: ssh-ed25519 SHA256:NFcLH9/wH3EK7sALDPE/VAZ2QF7R6V+zAL2UWC6DAqQ' \
  'debug1: Sending command: fixture' >> "$1"
IFS= read -r payload || exit 0
printf '%s' "$payload" > "$(dirname "$0")/mutated"
"#,
    );
    let deadline = Instant::now() + Duration::from_secs(1);
    let result =
        ssh.run_authenticated(&host(), &["unused"], "public key\n", Some(deadline), |_| {
            std::thread::sleep(deadline.saturating_duration_since(Instant::now()));
            Ok(())
        });
    assert!(result.unwrap_err().contains("pairing_deadline_elapsed"));
    assert!(
        !directory.path().join("mutated").exists(),
        "an expired exchange sent the key"
    );
}

#[test]
fn expired_deadline_does_not_spawn_the_next_ssh_process() {
    let (directory, ssh) = wrapper("touch \"$(dirname \"$0\")/spawned\"");
    let result = ssh.run_authenticated(
        &host(),
        &["unused"],
        "public key\n",
        Some(Instant::now()),
        |_| panic!("an expired exchange must not begin authentication"),
    );
    assert!(result.unwrap_err().contains("pairing_deadline_elapsed"));
    assert!(!directory.path().join("spawned").exists());
}
