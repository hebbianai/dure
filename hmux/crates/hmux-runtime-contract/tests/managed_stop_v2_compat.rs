use hmux_runtime_contract::{
    ManagedStopOutcome, ManagedStopReceipt, ManagedStopReconcileRequest, ManagedStopRequest,
    read_json_frame, write_json_frame,
};
use serde::Deserialize;
use serde_json::Value;
use std::io::Cursor;

// Frozen decoder/validator snapshots of the last unguarded managed-stop
// receipt and reconcile contracts. Serde intentionally ignores the new guard
// field, as the shipped decoder did; schemaVersion is therefore the fence that
// prevents a guarded v3 artifact from being mistaken for unguarded v2.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PinnedManagedStopReceiptV2 {
    schema: String,
    schema_version: u16,
    stop_id: String,
    session_id: String,
    workspace_id: String,
    runner_principal: String,
    runner_instance: String,
    channel_epoch: u64,
    host_instance_id: String,
    terminal_epoch: String,
    outcome: Value,
    exit_reason: String,
}

impl PinnedManagedStopReceiptV2 {
    fn validate(self) -> Result<(), &'static str> {
        if self.schema == "hmux-managed-stop-v1"
            && self.schema_version == 2
            && !self.stop_id.is_empty()
            && !self.session_id.is_empty()
            && !self.workspace_id.is_empty()
            && !self.runner_principal.is_empty()
            && !self.runner_instance.is_empty()
            && self.channel_epoch > 0
            && !self.host_instance_id.is_empty()
            && !self.terminal_epoch.is_empty()
            && self.outcome.is_string()
            && !self.exit_reason.is_empty()
        {
            Ok(())
        } else {
            Err("managed stop receipt has an unsupported v2 schema")
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PinnedManagedStopReconcileV2 {
    schema: String,
    schema_version: u16,
    stop_id: String,
    session_id: String,
    workspace_id: String,
    expected_runner_principal: String,
    expected_runner_instance: String,
    expected_channel_epoch: u64,
    expected_host_instance_id: String,
    expected_terminal_epoch: String,
}

impl PinnedManagedStopReconcileV2 {
    fn validate(self) -> Result<(), &'static str> {
        if self.schema == "hmux-managed-stop-reconcile-v1"
            && self.schema_version == 2
            && !self.stop_id.is_empty()
            && !self.session_id.is_empty()
            && !self.workspace_id.is_empty()
            && !self.expected_runner_principal.is_empty()
            && !self.expected_runner_instance.is_empty()
            && self.expected_channel_epoch > 0
            && !self.expected_host_instance_id.is_empty()
            && !self.expected_terminal_epoch.is_empty()
        {
            Ok(())
        } else {
            Err("managed stop reconcile request has an unsupported v2 schema")
        }
    }
}

fn complete_request() -> ManagedStopRequest {
    ManagedStopRequest::new("stop_compat", "session_compat", "workspace_compat")
        .unwrap()
        .with_expected_fence(
            "principal_compat",
            "runner_compat",
            7,
            "host_compat",
            "terminal_compat",
        )
        .unwrap()
}

fn pinned_receipt_accepts(receipt: &ManagedStopReceipt) -> bool {
    let mut framed = Vec::new();
    write_json_frame(&mut framed, receipt).unwrap();
    read_json_frame::<PinnedManagedStopReceiptV2>(&mut Cursor::new(framed))
        .ok()
        .and_then(|receipt| receipt.validate().ok())
        .is_some()
}

fn pinned_reconcile_accepts(request: &ManagedStopReconcileRequest) -> bool {
    let mut framed = Vec::new();
    write_json_frame(&mut framed, request).unwrap();
    read_json_frame::<PinnedManagedStopReconcileV2>(&mut Cursor::new(framed))
        .ok()
        .and_then(|request| request.validate().ok())
        .is_some()
}

#[test]
fn shipped_v2_decoders_accept_complete_v3_artifacts() {
    let complete = complete_request();
    let receipt = ManagedStopReceipt::from_request(
        &complete,
        ManagedStopOutcome::Stopped,
        "provider terminated by Hmux Host",
    )
    .unwrap();
    let reconcile = ManagedStopReconcileRequest::from_stop_request(&complete).unwrap();
    assert!(pinned_receipt_accepts(&receipt));
    assert!(pinned_reconcile_accepts(&reconcile));
}
