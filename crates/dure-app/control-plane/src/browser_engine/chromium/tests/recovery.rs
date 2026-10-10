use super::super::profile::RecoveryState;
use super::*;

fn identity() -> (BrowserProfileIdV1, BrowserInstanceId) {
    (
        BrowserProfileIdV1::new("recovery-fixture").unwrap(),
        BrowserInstanceId::new("fixture-instance").unwrap(),
    )
}

#[test]
fn recovery_refuses_live_claim_unknown_evidence_and_changed_file_without_touching_data() {
    let root = tempfile::tempdir().unwrap();
    let (id, instance) = identity();
    let mut claim = profile::ProfileClaim::acquire(root.path(), &id, &instance).unwrap();
    let path = claim.profile.parent().unwrap().join("native-claim.json");
    let bytes = fs::read(&path).unwrap();
    fs::write(claim.profile.join("retained"), b"user data").unwrap();
    assert_eq!(
        profile::recovery_status(root.path(), &id),
        RecoveryState::Live
    );
    assert_eq!(
        profile::recover_storage(root.path(), &id).unwrap_err().code,
        "browser_profile_recovery_in_progress"
    );
    claim.prepare_launch().unwrap();
    drop(claim);
    assert_eq!(
        profile::recovery_status(root.path(), &id),
        RecoveryState::RestartRequired
    );
    assert_eq!(
        profile::recover_storage(root.path(), &id).unwrap_err().code,
        "browser_profile_recovery_restart_required"
    );
    assert_eq!(fs::read(&path).unwrap(), bytes);
    assert_eq!(
        fs::read(path.parent().unwrap().join("profile/retained")).unwrap(),
        b"user data"
    );
    fs::write(&path, b"malformed claim").unwrap();
    assert_eq!(
        profile::recovery_status(root.path(), &id),
        RecoveryState::Unconfirmed
    );
    assert_eq!(
        profile::recover_storage(root.path(), &id).unwrap_err().code,
        "browser_profile_recovery_unconfirmed"
    );
    assert_eq!(fs::read(&path).unwrap(), b"malformed claim");
}

#[test]
fn legacy_claim_needs_a_reboot_witness_bound_to_exact_claim() {
    let root = tempfile::tempdir().unwrap();
    let (id, instance) = identity();
    let mut claim = profile::ProfileClaim::acquire(root.path(), &id, &instance).unwrap();
    let path = claim.profile.parent().unwrap().join("native-claim.json");
    claim.prepare_launch().unwrap();
    drop(claim);
    let legacy = json!({"schemaVersion":1,"profileId":id,"instanceId":instance});
    fs::write(&path, legacy.to_string()).unwrap();
    assert_eq!(
        profile::recover_storage(root.path(), &id).unwrap_err().code,
        "browser_profile_recovery_restart_required"
    );
    let witness = path.with_file_name("native-recovery.json");
    let mut record: serde_json::Value =
        serde_json::from_slice(&fs::read(&witness).unwrap()).unwrap();
    record["boot"] = "00000000-0000-0000-0000-000000000000".into();
    fs::write(&witness, record.to_string()).unwrap();
    assert_eq!(
        profile::recovery_status(root.path(), &id),
        RecoveryState::Recoverable
    );
    let mut other = legacy.clone();
    other["instanceId"] = "other-instance".into();
    fs::write(&path, other.to_string()).unwrap();
    assert_eq!(
        profile::recovery_status(root.path(), &id),
        RecoveryState::RestartRequired
    );
    fs::write(&path, legacy.to_string()).unwrap();
    profile::recover_storage(root.path(), &id).unwrap();
    assert!(!path.exists());
    profile::recover_storage(root.path(), &id).unwrap();
}

#[tokio::test]
async fn recovery_retains_claim_while_descendant_outlives_parent() {
    let root = tempfile::tempdir().unwrap();
    let (id, _) = identity();
    let executable = root.path().join("child");
    fs::write(
        &executable,
        br#"#!/bin/sh
for value in "$@"; do
 case "$value" in --user-data-dir=*) profile=${value#--user-data-dir=};; esac
done
(while [ ! -f "$profile/release-writer" ]; do /bin/sleep 0.01; done) &
printf 'DevTools listening on ws://127.0.0.1:65534/devtools/browser/descendant\n' >&2
while [ ! -f "$profile/stop" ]; do /bin/sleep 0.01; done
exit 17
"#,
    )
    .unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let mut browser = OwnedChromium::launch_profile(&executable, root.path(), &id)
        .await
        .unwrap();
    let data = browser.profile.as_ref().unwrap().profile.clone();
    fs::write(data.join("stop"), b"stop").unwrap();
    browser.wait_for_exit().await.unwrap();
    assert_eq!(
        browser.close().await.unwrap_err().code,
        "browser_profile_exit_unconfirmed"
    );
    drop(browser);
    assert_eq!(
        profile::recovery_status(root.path(), &id),
        RecoveryState::Live
    );
    assert_eq!(
        profile::recover_storage(root.path(), &id).unwrap_err().code,
        "browser_profile_owner_live"
    );
    fs::write(data.join("release-writer"), b"stop").unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while profile::recover_storage(root.path(), &id).is_err() {
        assert!(Instant::now() < deadline, "writer did not retire");
        sleep(Duration::from_millis(25)).await;
    }
    assert!(
        profile::ProfileClaim::acquire(
            root.path(),
            &id,
            &BrowserInstanceId::new("next-instance").unwrap()
        )
        .is_ok()
    );
}
