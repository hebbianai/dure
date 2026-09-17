#![cfg(unix)]

use hmux_client::{
    CompletedStandaloneTarget, CompletedStandaloneTargetLifecycle, LocalSessionCatalog,
    SessionRetirementReceiptState, SessionSelector, StandaloneCreateRequest,
    StandaloneRecipeRequirement, StandaloneRecoveryCreateIdentity, StandaloneSessionCreator,
    standalone_create_idempotency_key,
};
use hmux_runtime_contract::{ProviderStateEnvironment, TerminalDefaultColors, write_json_frame};
use serde_json::json;
use std::fs;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[test]
fn delayed_host_launch_cannot_restart_a_retired_standalone_creation() {
    let guardian = PathBuf::from(std::env::var_os("DURE_HMUX_TEST_STATE_ROOT").unwrap())
        .canonicalize()
        .unwrap();
    let cwd = tempfile::tempdir().unwrap().keep().canonicalize().unwrap();
    assert!(cwd.starts_with(&guardian) && cwd != guardian);
    let discovery = cwd.join("discovery");
    let marker = cwd.join("provider-started");
    let command = vec![
        "/bin/sh".into(),
        "-c".into(),
        "printf 'started\n' >> \"$1\"; exec /bin/sh".into(),
        "qa-provider".into(),
        marker.to_str().unwrap().into(),
    ];
    let identity = StandaloneRecoveryCreateIdentity::new("standalone_delayed", "delayed-proof")
        .unwrap()
        .with_recipe_requirement(StandaloneRecipeRequirement::RequestBound);
    let request =
        StandaloneCreateRequest::new(&cwd, Some("delayed-launch".into()), command.clone(), 24, 80)
            .unwrap()
            .with_recovery_identity(identity.clone())
            .unwrap();
    let executable = env!("CARGO_BIN_EXE_hmux-runtime");
    let catalog = LocalSessionCatalog::new(&discovery);
    let created = StandaloneSessionCreator::new(executable)
        .with_discovery_root(&discovery)
        .create(request.clone())
        .unwrap();
    wait_until(|| marker.exists());
    let original = created.session().descriptor();
    let target =
        CompletedStandaloneTarget::from_created(created.receipt().clone(), original).unwrap();
    // This is the broker's already prepared private launch packet, not a new
    // create operation. Deliver it only after an identical request has finished
    // its full lifetime, modeling a delayed Host behind a lost broker response.
    let packet = json!({
        "schema": "hmux-runtime-host-v1",
        "discoveryRoot": discovery,
        "providerProgram": command[0],
        "providerArgs": command[1..],
        "providerCwd": cwd,
        "workspaceId": original.workspace_id,
        "sessionId": original.session_id,
        "sessionClass": "standalone",
        "providerId": "local-shell",
        "sessionName": "delayed-launch",
        "idempotencyKey": standalone_create_idempotency_key(&identity),
        "initialRows": 24,
        "initialColumns": 80,
        "terminalDefaultColors": TerminalDefaultColors::default(),
        "terminalEnvironment": request.terminal_environment(),
        "providerStateEnvironment": ProviderStateEnvironment::default(),
        "launchOwnerProof": identity.launch_owner_proof(),
    });
    assert_eq!(
        created.abandon_unpresented_creation().unwrap().state,
        SessionRetirementReceiptState::RetirementArmed
    );
    wait_until(|| {
        catalog.resolve_completed_standalone_target(target.generation(), target.provider_process())
            == CompletedStandaloneTargetLifecycle::Retired
    });

    let mut delayed = Command::new(executable)
        .arg("internal-hmux-host")
        .env("HMUX_DISCOVERY_ROOT", &discovery)
        .current_dir(&cwd)
        .process_group(0)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    write_json_frame(&mut delayed.stdin.take().unwrap(), &packet).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let launched_again = loop {
        if fs::read_to_string(&marker).unwrap().lines().count() > 1 {
            break true;
        }
        if delayed.try_wait().unwrap().is_some() {
            break false;
        }
        assert!(Instant::now() < deadline, "delayed Host never settled");
        std::thread::sleep(Duration::from_millis(20));
    };
    if launched_again {
        let session = catalog
            .open(&SessionSelector::new(
                &original.session_id,
                Some(original.workspace_id.clone()),
            ))
            .unwrap();
        assert!(!session.descriptor().same_generation(original));
        session
            .terminate_standalone(&catalog, Duration::from_secs(3))
            .unwrap();
    }
    let output = delayed.wait_with_output().unwrap();
    let launches = fs::read_to_string(&marker).unwrap().lines().count();
    assert_eq!(
        (launched_again, launches),
        (false, 1),
        "an ended creation must stay ended at Host admission; delayed status={:?}",
        output.status
    );
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr)
            .contains("invalid manifest transition from retired to starting"),
        "unexpected refusal: {output:?}"
    );
    assert_eq!(
        catalog.resolve_completed_standalone_target(target.generation(), target.provider_process()),
        CompletedStandaloneTargetLifecycle::Retired
    );
}

fn wait_until(ready: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !ready() {
        assert!(
            Instant::now() < deadline,
            "native fixture did not reach its boundary"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}
