use super::{OPERATION, append, results::BrowserResults};
use crate::browser_engine::runtime::capture::CapturedFile;
use dure_app::{DomainStore, OperationEventBodyV1, OperationIdV1};
use dure_app_sqlite::SqliteDomainStore;
use hmux_session_protocol::browser_resource::*;
use serde_json::json;

#[tokio::test]
async fn payload_publication_does_not_complete_an_operation_and_terminal_results_survive_reopen() {
    let root = tempfile::tempdir().unwrap();
    let database = root.path().join("journal.sqlite3");
    let store = SqliteDomainStore::open(&database).await.unwrap();
    let results = BrowserResults::new(root.path());
    let operation = OperationIdV1::new("capture:test").unwrap();
    append(
        &store,
        &operation,
        1,
        OperationEventBodyV1::Started {
            idempotency_key: "fingerprint".into(),
            operation_kind: OPERATION.into(),
        },
    )
    .await
    .unwrap();
    let file = CapturedFile {
        page: BrowserPageIdentity {
            resource: BrowserResourceIdentity {
                resource_id: BrowserResourceId::new("browser:test").unwrap(),
                generation: BrowserResourceGeneration::new("generation:test").unwrap(),
                workspace_id: BrowserWorkspaceId::new("workspace:test").unwrap(),
            },
            page_id: BrowserPageId::new("page:test").unwrap(),
            document_revision: std::num::NonZeroU64::new(1).unwrap(),
        },
        mime_type: "image/png",
        suggested_filename: None,
        bytes: b"immutable image bytes".to_vec(),
    };
    let artifact = results.capture(operation.clone(), file).await.unwrap();
    let value = json!({"artifact":artifact});
    results
        .save(&operation, "fingerprint", &Ok(value.clone()))
        .await
        .unwrap();
    let running = store.operation_receipt(&operation).await.unwrap().unwrap();
    assert_eq!(
        results.recover(&running).unwrap()["result_available"],
        false
    );
    assert_eq!(
        results.chunk(&running, 0).unwrap_err().code,
        "browser_artifact_unavailable"
    );
    append(
        &store,
        &operation,
        2,
        OperationEventBodyV1::Succeeded {
            result_code: Some("browser_completed".into()),
        },
    )
    .await
    .unwrap();
    store.close().await;
    let reopened = SqliteDomainStore::open(&database).await.unwrap();
    let receipt = reopened
        .operation_receipt(&operation)
        .await
        .unwrap()
        .unwrap();
    let results = BrowserResults::new(root.path());
    assert_eq!(results.recover(&receipt).unwrap()["result"], value);
    let chunk = results.chunk(&receipt, 0).unwrap();
    assert_eq!(chunk["base64"], "aW1tdXRhYmxlIGltYWdlIGJ5dGVz");
    assert_eq!(chunk["eof"], true);
    assert!(
        results
            .save(&operation, "fingerprint", &Ok(json!({"replacement":true})))
            .await
            .is_err()
    );
    assert_eq!(results.recover(&receipt).unwrap()["result"], value);
    let mut conflicting = receipt.clone();
    conflicting.idempotency_key = "different".into();
    assert_eq!(
        results.recover(&conflicting).unwrap_err().code,
        "browser_operation_conflict"
    );
    reopened.close().await;
}
