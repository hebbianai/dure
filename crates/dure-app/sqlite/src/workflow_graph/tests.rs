use std::collections::BTreeMap;

use agent_orchestration::domain::graph::{
    ActionContract, ActionRef, CompiledWorkflow, FieldContract, FieldType, WorkflowChangeRequest,
    WorkflowPutRequest,
};
use serde_json::json;

use crate::SqliteDomainStore;

fn request() -> WorkflowPutRequest {
    serde_json::from_value(json!({"schemaVersion":1,"workflowId":"daily-review","expectedRevision":0,"idempotencyKey":"draft-1","name":"Daily review","trigger":{"kind":"schedule","expression":"0 9 * * *","timezone":"Asia/Seoul"},"definition":{"schemaVersion":1,"nodes":[{"nodeId":"collect","name":"Collect changes","action":{"actionId":"command","version":1},"inputs":{"script":{"kind":"literal","value":"git diff"}}}],"edges":[]}})).unwrap()
}

fn compile(request: &WorkflowPutRequest) -> CompiledWorkflow {
    CompiledWorkflow::parse(
        request.definition.clone(),
        &[ActionContract {
            action: ActionRef {
                action_id: "command".into(),
                version: 1,
            },
            inputs: BTreeMap::from([(
                "script".into(),
                FieldContract {
                    value_type: FieldType::String,
                    required: true,
                    accepts_output: false,
                },
            )]),
            outputs: BTreeMap::new(),
        }],
    )
    .unwrap()
}

fn change(revision: u64, key: &str) -> WorkflowChangeRequest {
    WorkflowChangeRequest {
        schema_version: 1,
        workflow_id: "daily-review".into(),
        expected_revision: revision,
        idempotency_key: key.into(),
    }
}

#[tokio::test]
async fn workflow_graph_active_version_survives_draft_edits_pause_and_reopen() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("domain.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    let mut draft = request();
    let saved = store.put_workflow_definition(&draft, 100).await.unwrap();
    assert_eq!(saved.revision, 1);
    let active = store
        .activate_workflow_definition(&change(1, "activate-1"), &compile(&draft), 200)
        .await
        .unwrap();
    assert!(active.enabled);
    let original = store
        .workflow_version("daily-review", 1)
        .await
        .unwrap()
        .unwrap();
    draft.expected_revision = 2;
    draft.idempotency_key = "draft-2".into();
    draft.name = "Edited draft".into();
    // Incomplete drafts are retained without replacing the active executable version.
    draft.definition.nodes.clear();
    let edited = store.put_workflow_definition(&draft, 300).await.unwrap();
    assert!(edited.enabled);
    assert_eq!(edited.active_version, Some(1));
    let paused = store
        .pause_workflow_definition(&change(3, "pause-1"), 400)
        .await
        .unwrap();
    assert!(!paused.enabled);
    store.pool.close().await;
    let reopened = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        reopened
            .workflow_definition("daily-review")
            .await
            .unwrap()
            .unwrap(),
        paused
    );
    assert_eq!(
        reopened
            .workflow_version("daily-review", 1)
            .await
            .unwrap()
            .unwrap(),
        original
    );
    assert_eq!(original.name, "Daily review");
    assert_eq!(original.definition.nodes.len(), 1);
}

#[tokio::test]
async fn workflow_graph_exact_retry_returns_receipt_and_rejects_changed_intent() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    let draft = request();
    let first = store.put_workflow_definition(&draft, 100).await.unwrap();
    let active = store
        .activate_workflow_definition(&change(1, "activate-1"), &compile(&draft), 200)
        .await
        .unwrap();
    assert_eq!(
        store.put_workflow_definition(&draft, 300).await.unwrap(),
        first
    );
    assert_eq!(
        store
            .activate_workflow_definition(&change(1, "activate-1"), &compile(&draft), 400)
            .await
            .unwrap(),
        active
    );
    let mut changed = draft.clone();
    changed.name = "Different intent".into();
    assert!(store.put_workflow_definition(&changed, 500).await.is_err());
    assert!(
        store
            .pause_workflow_definition(&change(1, "stale-pause"), 500)
            .await
            .is_err()
    );
    assert!(
        store
            .workflow_version("daily-review", 2)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn workflow_graph_stale_compilation_cannot_activate_a_changed_draft() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    let original = request();
    store.put_workflow_definition(&original, 100).await.unwrap();
    let mut changed = original.clone();
    changed.expected_revision = 1;
    changed.idempotency_key = "draft-2".into();
    changed.definition.nodes[0].name = "Different step".into();
    store.put_workflow_definition(&changed, 200).await.unwrap();
    assert!(
        store
            .activate_workflow_definition(&change(2, "activate-stale"), &compile(&original), 300)
            .await
            .is_err()
    );
    assert!(
        store
            .workflow_version("daily-review", 1)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        !store
            .workflow_definition("daily-review")
            .await
            .unwrap()
            .unwrap()
            .enabled
    );
}

#[tokio::test]
async fn workflow_graph_concurrent_edit_has_one_cas_winner() {
    let root = tempfile::tempdir().unwrap();
    let store = SqliteDomainStore::open(root.path().join("domain.sqlite"))
        .await
        .unwrap();
    let draft = request();
    store.put_workflow_definition(&draft, 100).await.unwrap();
    let mut first = draft.clone();
    first.expected_revision = 1;
    first.idempotency_key = "edit-a".into();
    let mut second = first.clone();
    second.idempotency_key = "edit-b".into();
    let (a, b) = tokio::join!(
        store.put_workflow_definition(&first, 200),
        store.put_workflow_definition(&second, 200)
    );
    assert_ne!(a.is_ok(), b.is_ok());
    assert_eq!(
        store
            .workflow_definition("daily-review")
            .await
            .unwrap()
            .unwrap()
            .revision,
        2
    );
}
