use super::*;
use hmux_client::recovery_journal::{
    PreparedRecoveryIdentity, RecoveryCompletion, RecoveryReservationState, reserve_prepared,
};
use hmux_client::{
    MANAGED_REHOST_RECOVERY_ACTION, MANAGED_REHOST_RECOVERY_ID_PREFIX,
    ManagedCreateGenerationFence, ManagedCreateOutcome, ManagedCreateReceipt, ManagedStopOutcome,
    ManagedStopReceipt, ManagedStopRequest, PermissionMode,
};

fn request(source: &SessionFence) -> serde_json::Value {
    serde_json::json!({
        "gateway_request_version": 11,
        "request": { "resolve_session": { "expected_fence": source } }
    })
}

#[test]
fn a_mobile_reconnect_reads_unknown_pending_and_durable_successor_without_attaching() {
    let fixture = Fixture::start();
    let mut source = fixture.fence();
    source.session_id = "retired-mobile-source".into();
    source.host_instance_id = "retired-host".into();
    source.terminal_epoch = "retired-terminal".into();
    let controller_before = fixture.controller_generation();
    let query = || fixture.gateway_request(request(&source));
    assert_eq!(query()["state"], "unknown");

    let operation_id = "mobile-successor-fixture";
    let RecoveryReservationState::Pending(mut reservation) = reserve_prepared(
        &fixture.discovery_root,
        PreparedRecoveryIdentity {
            recovery_id: format!("{MANAGED_REHOST_RECOVERY_ID_PREFIX}{operation_id}"),
            source_session_id: source.session_id.clone(),
            source_workspace_id: source.workspace_id.clone(),
            action: MANAGED_REHOST_RECOVERY_ACTION,
            legacy_request_fingerprint: None,
        },
        Some(serde_json::json!({ "operationId": operation_id }).to_string()),
    )
    .unwrap() else {
        panic!("new fixture must reserve one operation")
    };
    assert_eq!(query()["state"], "pending");

    let stopped = ManagedStopReceipt::from_request(
        &ManagedStopRequest::new("stop-source", &source.session_id, &source.workspace_id)
            .unwrap()
            .with_expected_fence(
                &source.runner_principal,
                &source.runner_instance,
                source.channel_epoch,
                &source.host_instance_id,
                &source.terminal_epoch,
            )
            .unwrap(),
        ManagedStopOutcome::Stopped,
        "fixture source retired",
    )
    .unwrap();
    let target = fixture.fence();
    let created = ManagedCreateReceipt::new(
        "create-successor",
        &target.session_id,
        &target.workspace_id,
        "shell",
        PermissionMode::BypassApprovals,
        &fixture.discovery_root,
        ManagedCreateOutcome::Created,
    )
    .unwrap()
    .with_generation_fence(
        ManagedCreateGenerationFence::new(
            &target.runner_principal,
            &target.runner_instance,
            target.channel_epoch,
            &target.host_instance_id,
            &target.terminal_epoch,
        )
        .unwrap(),
    )
    .unwrap();
    reservation
        .checkpoint_source_stop_receipt(serde_json::to_string(&stopped).unwrap())
        .unwrap();
    reservation
        .checkpoint_replacement_receipt(serde_json::to_string(&created).unwrap())
        .unwrap();
    reservation
        .complete(RecoveryCompletion {
            target_session_id: target.session_id.clone(),
            target_workspace_id: target.workspace_id.clone(),
            target_build_id: "fixture-build".into(),
            action: MANAGED_REHOST_RECOVERY_ACTION.into(),
            outcome: "rehosted".into(),
            resume_checkpoint: None,
            operation_checkpoint: None,
        })
        .unwrap();
    drop(reservation);

    let resolved = query();
    assert_eq!(resolved["gateway_session_resolution_version"], 1);
    assert_eq!(resolved["state"], "resolved");
    assert_eq!(
        resolved["source_fence"],
        serde_json::to_value(&source).unwrap()
    );
    assert_eq!(resolved["session"]["session_id"], target.session_id);
    assert_eq!(resolved["session"]["terminal_epoch"], target.terminal_epoch);
    // A fresh gateway process rereads the durable edge; no in-memory lineage is required.
    assert_eq!(query(), resolved);
    assert_eq!(fixture.controller_generation(), controller_before);
    assert!(
        !serde_json::to_string(&resolved)
            .unwrap()
            .contains("capability_token")
    );
    let encoded = gateway_request_output(&fixture.discovery_root, request(&source));
    let hmux_ssh_transport::session_resolution::SessionResolution::Resolved { session } =
        hmux_ssh_transport::session_resolution::read::<hmux_ssh_transport::RemoteCatalogSession>(
            &mut encoded.stdout.as_slice(),
            &source,
        )
        .unwrap()
    else {
        panic!("shared native reader must decode the real gateway response")
    };
    assert_eq!(session.session_id, target.session_id);
    for (flag, pin) in [
        ("--session", source.session_id.as_str()),
        ("--session", target.session_id.as_str()),
        ("--workspace", "another-workspace"),
    ] {
        let mut child = Command::new(env!("CARGO_BIN_EXE_hmux"))
            .arg("--discovery-root")
            .arg(&fixture.discovery_root)
            .args(["mobile-gateway", "--role", "observer", flag, pin])
            .env(
                "SSH_ORIGINAL_COMMAND",
                "peer-controlled text must not widen scope",
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(&hmux_ssh_transport::session_resolution::request(&source).unwrap())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(!output.status.success());
        assert_eq!(
            catalog_documents(&output.stdout)[0]["body"]["payload"]["code"],
            "authorization_denied"
        );
    }
    let mut foreign = source.clone();
    foreign.runner_principal = "different-account".into();
    let refused = gateway_request_output(&fixture.discovery_root, request(&foreign));
    assert!(!refused.status.success());
    assert_eq!(
        catalog_documents(&refused.stdout)[0]["body"]["payload"]["code"],
        "identity_mismatch"
    );
}
