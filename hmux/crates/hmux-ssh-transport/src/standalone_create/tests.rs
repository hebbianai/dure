use super::*;
use crate::{RemoteCatalogSession, RemoteCommandIntercept};
use std::collections::BTreeSet;

fn private_root() -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    root
}

fn request() -> RemoteStandaloneCreateRequest {
    RemoteStandaloneCreateRequest {
        request_id: "operation-1".into(),
        target_session_id: "standalone-operation-1".into(),
        launch_owner_proof: "first-private-proof".into(),
        session_name: "remote-operation-1".into(),
        bridge_nonce: "bridge-operation-1".into(),
        cwd: Some("/fixture".into()),
        initial_rows: 24,
        initial_columns: 80,
        command_intercepts: vec![RemoteCommandIntercept {
            command: "agent".into(),
            provider_id: "fixture".into(),
        }],
        retirement_policy: None,
    }
}

fn receipt(request: &RemoteStandaloneCreateRequest) -> RemoteStandaloneCreateReceipt {
    RemoteStandaloneCreateReceipt {
        request_id: request.request_id.clone(),
        bridge_nonce: request.bridge_nonce.clone(),
        session: serde_json::from_value::<RemoteCatalogSession>(serde_json::json!({
            "session_id": request.target_session_id,
            "session_name": request.session_name,
            "workspace_id": "remote-workspace",
            "session_class": "standalone",
            "lifecycle": "ready",
            "provider_id": "shell",
            "runner_principal": "fixture",
            "runner_instance": "runner-1",
            "channel_epoch": "1",
            "host_instance_id": "host-1",
            "terminal_epoch": "terminal-1",
            "supported_protocol": {"minimum": {"major": 1, "minor": 0}, "maximum": {"major": 1, "minor": 0}},
            "capabilities": []
        })).unwrap(),
    }
}

#[test]
fn response_loss_reopens_the_same_private_request_and_completed_receipt() {
    let root = private_root();
    let initial = request();
    let mut targets = BTreeSet::new();
    let lost = execute(root.path(), "owner-and-host", initial.clone(), |prepared| {
        targets.insert((
            prepared.target_session_id.clone(),
            prepared.launch_owner_proof.clone(),
        ));
        Err(CatalogError::Response("fixture lost response".into()))
    });
    assert!(lost.is_err());
    // A new frontend realm proposes a new proof and current geometry. The
    // durable operation, not those replaceable hints, owns the first launch.
    let mut retry = initial.clone();
    retry.launch_owner_proof = "second-private-proposal".into();
    retry.initial_rows = 50;
    let restored = execute(root.path(), "owner-and-host", retry.clone(), |prepared| {
        assert_eq!(prepared, initial);
        targets.insert((
            prepared.target_session_id.clone(),
            prepared.launch_owner_proof.clone(),
        ));
        Ok(receipt(&prepared))
    })
    .unwrap();
    assert_eq!(targets.len(), 1);
    assert_eq!(restored.launch_owner_proof, initial.launch_owner_proof);
    let reopened = execute(root.path(), "owner-and-host", retry, |_| {
        panic!("completed replay must not create")
    })
    .unwrap();
    assert_eq!(reopened.receipt, restored.receipt);
    assert_eq!(reopened.launch_owner_proof, restored.launch_owner_proof);
    assert!(!format!("{reopened:?}").contains("first-private-proof"));
}

#[test]
fn changed_owner_destination_or_launch_input_cannot_retarget_a_pending_operation() {
    let root = private_root();
    let initial = request();
    execute(root.path(), "owner-and-host", initial.clone(), |_| {
        Err(CatalogError::Response("lost".into()))
    })
    .unwrap_err();
    let changed_scope = execute(root.path(), "other-owner-or-host", initial.clone(), |_| {
        panic!("changed scope must not create")
    });
    assert!(
        changed_scope
            .unwrap_err()
            .to_string()
            .contains("idempotency_conflict")
    );
    for field in ["target", "cwd", "bridge", "intercepts"] {
        let mut changed = initial.clone();
        match field {
            "target" => changed.target_session_id = "other-target".into(),
            "cwd" => changed.cwd = Some("/other".into()),
            "bridge" => changed.bridge_nonce = "other-bridge".into(),
            "intercepts" => changed.command_intercepts[0].command = "other".into(),
            _ => unreachable!(),
        }
        let result = execute(root.path(), "owner-and-host", changed, |_| {
            panic!("changed launch must not create")
        });
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("idempotency_conflict")
        );
    }
}

#[test]
fn an_in_flight_operation_cannot_be_executed_by_a_second_caller() {
    let root = private_root();
    let initial = request();
    let result = execute(root.path(), "owner", initial.clone(), |prepared| {
        let raced = execute(root.path(), "owner", initial, |_| {
            panic!("second caller must not execute")
        });
        assert!(raced.unwrap_err().to_string().contains("busy"));
        Ok(receipt(&prepared))
    })
    .unwrap();
    assert_eq!(result.receipt.session.session_id, "standalone-operation-1");
}

#[test]
fn an_invalid_request_publishes_nothing_and_never_calls_transport() {
    let root = private_root();
    let mut invalid = request();
    invalid.initial_rows = 0;
    assert!(
        execute(root.path(), "owner", invalid, |_| panic!(
            "invalid request must not execute"
        ))
        .is_err()
    );
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
}
