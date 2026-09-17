use std::fs;
use std::path::PathBuf;

use dure_app::{
    DelegateOnceReceiptV1, DelegateOnceRequestV1, WorkflowDispatchStateV1, prepare_delegate_once,
};
use serde_json::Value;

const REQUEST_DIGEST: &str = "d0094abf88333ccf4f020d4c3fb993fd9aa2f789cf689443889f3d1924768c20";

fn fixture(name: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../orchestration/tests/fixtures/delegate-once-v1")
        .join(name);
    fs::read_to_string(path).expect("read orchestration migration fixture")
}

fn request_fixture() -> DelegateOnceRequestV1 {
    serde_json::from_str(&fixture("request.json")).expect("parse delegate_once request fixture")
}

fn receipt_fixture(name: &str) -> DelegateOnceReceiptV1 {
    serde_json::from_str(&fixture(name)).expect("parse delegate_once receipt fixture")
}

#[test]
fn pinned_request_reproduces_the_starting_receipt() {
    let request = request_fixture();
    let prepared = prepare_delegate_once(&request).expect("prepare pinned delegate_once request");
    let expected = receipt_fixture("starting-receipt.json");

    assert_eq!(prepared.request_digest, REQUEST_DIGEST);
    assert_eq!(prepared.receipt, expected);
    assert_eq!(
        serde_json::to_value(&prepared.receipt).expect("serialize starting receipt"),
        serde_json::from_str::<Value>(&fixture("starting-receipt.json"))
            .expect("parse starting receipt value")
    );
}

#[test]
fn pinned_active_and_completed_receipts_preserve_the_exact_generation() {
    let starting = receipt_fixture("starting-receipt.json");
    let active = receipt_fixture("active-receipt.json");
    let completed = receipt_fixture("completed-receipt.json");

    for receipt in [&starting, &active, &completed] {
        receipt.validate().expect("validate pinned receipt");
        assert_eq!(receipt.generation, 1);
        assert_eq!(receipt.run_id, starting.run_id);
        assert_eq!(receipt.task_id, starting.task_id);
        assert_eq!(receipt.dispatch_id, starting.dispatch_id);
        assert_eq!(
            receipt.launch_idempotency_key,
            starting.launch_idempotency_key
        );
    }

    assert_eq!(starting.status, WorkflowDispatchStateV1::Starting);
    assert_eq!(active.status, WorkflowDispatchStateV1::Active);
    assert_eq!(completed.status, WorkflowDispatchStateV1::Completed);
    assert_eq!(active.session, completed.session);
    assert_eq!(active.prompt_delivery, completed.prompt_delivery);
    assert_eq!(active.result, None);
    assert_eq!(
        completed.result.as_deref(),
        Some("Reviewed the bounded change; no blocking findings.")
    );
}
