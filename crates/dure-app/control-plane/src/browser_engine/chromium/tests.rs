use super::*;
use dure_app::BrowserProfileIdV1;

#[tokio::test]
async fn profile_startup_uses_owned_output_and_drains_later_diagnostics() {
    let root = tempfile::tempdir().unwrap();
    let executable = root.path().join("child");
    fs::write(
        &executable,
        br#"#!/bin/sh
for value in "$@"; do
  case "$value" in --user-data-dir=*) profile=${value#--user-data-dir=};; esac
done
printf '65533\n/devtools/browser/stale-file\n' > "$profile/DevToolsActivePort"
printf 'DevTools listening on ws://127.0.0.1:65534/devtools/browser/owned-output\n' >&2
/bin/dd if=/dev/zero bs=65536 count=16 >&2 2>/dev/null
printf 'drained' > "$profile/diagnostics-complete"
while [ ! -f "$profile/stop" ]; do /bin/sleep 0.01; done
exit 0
"#,
    )
    .unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let id = BrowserProfileIdV1::new("output-proof").unwrap();
    let mut browser = OwnedChromium::launch_profile(&executable, root.path(), &id)
        .await
        .unwrap();
    let endpoint = browser.endpoint().to_owned();
    let profile = browser.profile.as_ref().unwrap().profile.clone();
    let drained = tokio::time::timeout(Duration::from_secs(5), async {
        while !profile.join("diagnostics-complete").is_file() {
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    // Ask this fixture to exit normally, then confirm its retained Child handle.
    // Neither fixture address nor a file-derived PID is used for process control.
    fs::write(profile.join("stop"), b"stop").unwrap();
    let exited = browser.wait_for_exit().await;
    let retired = browser.close().await;
    assert!(drained.is_ok(), "owned child output was not drained");
    assert!(exited.is_ok() && retired.is_ok(), "{exited:?} {retired:?}");
    assert_eq!(
        endpoint,
        "ws://127.0.0.1:65534/devtools/browser/owned-output"
    );
    assert_eq!(
        fs::read_to_string(profile.join("DevToolsActivePort")).unwrap(),
        "65533\n/devtools/browser/stale-file\n"
    );
    let claimed_again = profile::ProfileClaim::acquire(
        root.path(),
        &id,
        &BrowserInstanceId::new("next-instance").unwrap(),
    );
    assert!(claimed_again.is_ok());
}

#[test]
fn profile_claim_requires_confirmed_retirement_and_preserves_preferences() {
    let root = tempfile::tempdir().unwrap();
    let id = BrowserProfileIdV1::new("stored-profile").unwrap();
    let instance = BrowserInstanceId::new("instance-one").unwrap();
    let mut claim = profile::ProfileClaim::acquire(root.path(), &id, &instance).unwrap();
    let preferences = claim.profile.join("Default/Preferences");
    let mut value: serde_json::Value =
        serde_json::from_slice(&fs::read(&preferences).unwrap()).unwrap();
    value["custom"] = json!({"retained":"한글 설정"});
    fs::write(&preferences, serde_json::to_vec(&value).unwrap()).unwrap();
    let duplicate = profile::ProfileClaim::acquire(root.path(), &id, &instance)
        .err()
        .unwrap();
    assert_eq!(duplicate.code, "browser_profile_exit_unconfirmed");
    claim.started();
    claim.release_after_exit().unwrap();
    drop(claim);
    let mut reopened = profile::ProfileClaim::acquire(root.path(), &id, &instance).unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&fs::read(&preferences).unwrap()).unwrap(),
        value
    );
    reopened.started();
    drop(reopened);
    // A dropped running claim is uncertain, not permission to adopt or relaunch.
    assert_eq!(
        profile::ProfileClaim::acquire(root.path(), &id, &instance)
            .err()
            .unwrap()
            .code,
        "browser_profile_exit_unconfirmed"
    );
}

#[tokio::test]
async fn profile_forced_startup_retirement_preserves_its_unconfirmed_storage_claim() {
    let root = tempfile::tempdir().unwrap();
    let executable = root.path().join("child");
    fs::write(&executable,b"#!/bin/sh\nprintf 'DevTools listening on ws://example.invalid:80/devtools/browser/foreign\\n' >&2\nexec /bin/sleep 30\n").unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let id = BrowserProfileIdV1::new("failed-startup").unwrap();
    let code = OwnedChromium::launch_profile(&executable, root.path(), &id)
        .await
        .err()
        .unwrap()
        .code;
    assert_eq!(code, "browser_chromium_endpoint_invalid");
    assert_eq!(
        profile::ProfileClaim::acquire(
            root.path(),
            &id,
            &BrowserInstanceId::new("retry-instance").unwrap()
        )
        .err()
        .unwrap()
        .code,
        "browser_profile_exit_unconfirmed"
    );
}

#[test]
fn profile_retirement_cannot_remove_a_replaced_claim() {
    let root = tempfile::tempdir().unwrap();
    let id = BrowserProfileIdV1::new("replaced-claim").unwrap();
    let mut claim = profile::ProfileClaim::acquire(
        root.path(),
        &id,
        &BrowserInstanceId::new("instance-one").unwrap(),
    )
    .unwrap();
    claim.started();
    let path = claim.profile.parent().unwrap().join("native-claim.json");
    fs::rename(&path, path.with_extension("retained")).unwrap();
    fs::write(&path, b"replacement claimant").unwrap();
    let error = claim.release_after_exit().unwrap_err();
    drop(claim);
    assert_eq!(error.code, "browser_profile_retirement_unconfirmed");
    assert_eq!(fs::read(&path).unwrap(), b"replacement claimant");
}

#[tokio::test]
async fn profile_abnormal_exit_keeps_its_claim_after_close_and_drop() {
    use std::os::unix::process::ExitStatusExt;

    for (termination, code, signal) in [
        ("exit 17", Some(17), None),
        ("kill -TERM $$", None, Some(15)),
    ] {
        let root = tempfile::tempdir().unwrap();
        let executable = root.path().join("child");
        fs::write(
            &executable,
            format!(
                r#"#!/bin/sh
for value in "$@"; do
  case "$value" in --user-data-dir=*) profile=${{value#--user-data-dir=}};; esac
done
printf 'DevTools listening on ws://127.0.0.1:65534/devtools/browser/abnormal-exit\n' >&2
while [ ! -f "$profile/stop" ]; do /bin/sleep 0.01; done
{termination}
"#
            ),
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let id = BrowserProfileIdV1::new("abnormal-exit").unwrap();
        let mut browser = OwnedChromium::launch_profile(&executable, root.path(), &id)
            .await
            .unwrap();
        let profile = browser.profile.as_ref().unwrap().profile.clone();
        let claim = profile.parent().unwrap().join("native-claim.json");
        let before = fs::read(&claim).unwrap();
        fs::write(profile.join("stop"), b"stop").unwrap();
        let exited = browser.wait_for_exit().await;
        let retired = browser.close().await;
        let status = browser.exit_status;
        drop(browser);
        assert!(exited.is_ok(), "{exited:?}");
        let error = retired.unwrap_err();
        assert_eq!(error.code, "browser_profile_exit_unconfirmed");
        assert!(error.outcome_unknown);
        let status = status.expect("exact owned child was reaped");
        assert_eq!(status.code(), code);
        assert_eq!(status.signal(), signal);
        assert_eq!(fs::read(&claim).unwrap(), before);
        assert_eq!(
            profile::ProfileClaim::acquire(
                root.path(),
                &id,
                &BrowserInstanceId::new("next-instance").unwrap(),
            )
            .err()
            .unwrap()
            .code,
            "browser_profile_exit_unconfirmed"
        );
    }
}
