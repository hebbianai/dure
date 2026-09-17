use super::*;
use dure_app::{
    ProviderPermissionModeV1, WorkflowSessionLaunchRequestV1, WorkflowSessionPrelaunchCommandV1,
    WorkflowSessionResumePlanV1,
};

fn launch(request: &DelegateOnceRequestV1) -> WorkflowSessionLaunchRequestV1 {
    let prepared = prepare_delegate_once(request).unwrap();
    WorkflowSessionLaunchRequestV1 {
        runtime_kind_id: request.runtime_kind_id.clone(),
        launch_idempotency_key: prepared.receipt.launch_idempotency_key,
        session_id: workflow_prepared_session_id(&prepared.receipt.dispatch_id).unwrap(),
        workspace_id: "workspace-1".into(),
        provider_id: request.provider_id.clone(),
        provider_conversation_ref: Some("conversation-1".into()),
        permission_mode: ProviderPermissionModeV1::Default,
        provider_executable: "/fixture/provider".into(),
        provider_arguments: vec!["--model".into(), "fixture-model".into()],
        provider_resume: Some(WorkflowSessionResumePlanV1 {
            arguments: vec!["resume".into(), "{conversation}".into()],
            launch_reference: Some("credential-owner-reference".into()),
        }),
        initial_prompt: Some("Initial task".into()),
        working_directory: "/fixture/checkout".into(),
        prelaunch_command: Some(WorkflowSessionPrelaunchCommandV1::new("true").unwrap()),
    }
}

#[tokio::test]
async fn prepared_launch_is_first_writer_owned_and_survives_reopen() {
    let root = tempdir().unwrap();
    let path = root.path().join("domain.sqlite");
    let first = SqliteDomainStore::open(&path).await.unwrap();
    let second = SqliteDomainStore::open(&path).await.unwrap();
    let request = request();
    let original_receipt = first.create_delegate_once(&request).await.unwrap();
    let original = launch(&request);
    let mut changed = original.clone();
    changed.working_directory = "/fixture/new-checkout".into();
    changed.provider_arguments = vec!["--different-model".into()];
    let (left, right) = tokio::join!(
        first.prepare_delegate_once_launch(&request, &original),
        second.prepare_delegate_once_launch(&request, &changed),
    );
    let winner = left.unwrap();
    assert_eq!(winner, right.unwrap());
    assert!(winner == original || winner == changed);
    first.close().await;
    second.close().await;
    let reopened = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        reopened
            .delegate_once_launch(&request.idempotency_key)
            .await
            .unwrap(),
        Some(winner.clone()),
    );
    assert_eq!(
        reopened
            .prepare_delegate_once_launch(&request, &changed)
            .await
            .unwrap(),
        winner,
    );
    assert_eq!(
        reopened
            .delegate_once_receipt(&request.idempotency_key)
            .await
            .unwrap(),
        Some(original_receipt),
        "preparing launch input does not claim a successful runtime binding",
    );
    let mut conflicting = request.clone();
    conflicting.task.instructions = "A different task".into();
    assert!(matches!(
        reopened
            .prepare_delegate_once_launch(&conflicting, &launch(&conflicting))
            .await,
        Err(DomainStoreErrorV1::IdempotencyConflict { .. }),
    ));
    let mut wrong_identity = original;
    wrong_identity.session_id = "another-worker".into();
    assert!(matches!(
        reopened
            .prepare_delegate_once_launch(&request, &wrong_identity)
            .await,
        Err(DomainStoreErrorV1::IdentityConflict { .. }),
    ));
    assert_eq!(
        reopened
            .delegate_once_launch(&request.idempotency_key)
            .await
            .unwrap(),
        Some(winner),
    );
}

#[tokio::test]
async fn schema_43_migrates_existing_delegates_without_guessing_launch_input() {
    let root = tempdir().unwrap();
    let path = root.path().join("domain.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    let request = request();
    let pending = store.create_delegate_once(&request).await.unwrap();
    let mut active_request = request.clone();
    active_request.idempotency_key = "already-active".into();
    let active = store.create_delegate_once(&active_request).await.unwrap();
    let active = store
        .bind_delegate_once_session(&binding(&active))
        .await
        .unwrap();
    sqlx::query("ALTER TABLE workflow_dispatch_launches DROP COLUMN prepared_launch_json")
        .execute(&store.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE store_metadata SET schema_version = 43 WHERE singleton = 1")
        .execute(&store.pool)
        .await
        .unwrap();
    store.close().await;

    let migrated = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        migrated.schema_info().schema_version,
        CURRENT_STORE_SCHEMA_VERSION
    );
    for receipt in [&pending, &active] {
        assert_eq!(
            migrated
                .delegate_once_receipt(&receipt.idempotency_key)
                .await
                .unwrap()
                .as_ref(),
            Some(receipt),
        );
        assert!(
            migrated
                .delegate_once_launch(&receipt.idempotency_key)
                .await
                .unwrap()
                .is_none()
        );
    }
    let prepared = launch(&request);
    assert_eq!(
        migrated
            .prepare_delegate_once_launch(&request, &prepared)
            .await
            .unwrap(),
        prepared,
        "an older pending delegate can prepare input after normal coordinator preflight",
    );
    assert!(
        migrated
            .prepare_delegate_once_launch(&active_request, &launch(&active_request))
            .await
            .is_err(),
        "an already active delegate cannot receive a new launch intent",
    );
}
