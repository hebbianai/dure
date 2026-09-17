use dure_app::{
    DomainStoreErrorV1, ProjectIdV1, ProviderIdV1, ProviderPermissionModeV1,
    SCHEDULE_SCHEMA_VERSION_V1, ScheduleDeleteRequestV1, ScheduleIdV1, ScheduleLaunchStateV1,
    SchedulePutRequestV1, ScheduleRunTemplateV1,
};
use sqlx::Connection;
use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection};
use tempfile::TempDir;

use super::SqliteDomainStore;
use super::schema::downgrade_workflow_launch_fixture_to_v31;

fn put_request() -> SchedulePutRequestV1 {
    SchedulePutRequestV1 {
        schema_version: SCHEDULE_SCHEMA_VERSION_V1,
        schedule_id: ScheduleIdV1::new("morning-triage").unwrap(),
        expected_revision: 0,
        idempotency_key: "schedule-put-1".into(),
        name: "Morning triage".into(),
        enabled: true,
        expression: "0 9 * * 1-5".into(),
        timezone: "Asia/Seoul".into(),
        run_template: ScheduleRunTemplateV1 {
            project_id: ProjectIdV1::new("dure").unwrap(),
            provider_id: ProviderIdV1::new("codex").unwrap(),
            prompt: "triage ready work".into(),
            model: None,
            effort: None,
            permission_mode: Some(ProviderPermissionModeV1::Default),
            execution_profile: dure_app::AgentExecutionProfileV1::ProviderDefault,
            worktree: dure_app::ScheduleWorkspacePolicyV1::default(),
        },
    }
}

#[tokio::test]
async fn manual_run_preserves_cron_admission_and_its_original_template_after_restart() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("state.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    let mut request = put_request();
    request.run_template.model =
        Some(dure_app::AgentSpawnModelSelectionV1::parse("gpt-6-astra").unwrap());
    request.run_template.effort =
        Some(dure_app::AgentSpawnEffortSelectionV1::parse("xhigh").unwrap());
    let schedule = store.put_schedule(&request, 60_000).await.unwrap();
    let manual = store
        .run_schedule_once(&schedule.schedule_id, 1, "manual-review-1", 120_123)
        .await
        .unwrap();
    assert_eq!(manual.trigger, dure_app::ScheduleTriggerV1::Manual);
    assert_eq!(
        store
            .schedule(&schedule.schedule_id)
            .await
            .unwrap()
            .unwrap(),
        schedule
    );
    let due = store
        .claim_schedule_occurrence(&schedule.schedule_id, 1, 120_000, "due-review-1", 120_123)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        due.0.trigger,
        dure_app::ScheduleTriggerV1::Scheduled {
            scheduled_for_ms: 120_000
        }
    );
    assert_ne!(due.0.idempotency_key, manual.idempotency_key);

    request.expected_revision = 1;
    request.idempotency_key = "edit-review-template".into();
    request.run_template.prompt = "Edited for the next run".into();
    request.run_template.model = None;
    request.run_template.effort = None;
    store.put_schedule(&request, 120_124).await.unwrap();
    store.close().await;
    let store = SqliteDomainStore::open(&path).await.unwrap();
    assert_eq!(
        store
            .run_schedule_once(&schedule.schedule_id, 1, "manual-review-1", 180_000)
            .await
            .unwrap(),
        manual
    );
    let pending = store.pending_schedule_occurrences(10).await.unwrap();
    assert_eq!(pending.len(), 2);
    assert!(
        pending
            .iter()
            .all(|(_, template)| template == &schedule.run_template)
    );
    assert!(
        store
            .run_schedule_once(&schedule.schedule_id, 2, "manual-review-1", 180_001)
            .await
            .is_err()
    );
    assert!(
        store
            .claim_schedule_occurrence(
                &schedule.schedule_id,
                2,
                120_000,
                "duplicate-minute",
                180_001
            )
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn manual_run_can_test_a_disabled_schedule_without_enabling_it() {
    let temp = TempDir::new().unwrap();
    let store = SqliteDomainStore::open(temp.path().join("state.sqlite"))
        .await
        .unwrap();
    let mut request = put_request();
    request.enabled = false;
    let schedule = store.put_schedule(&request, 60_000).await.unwrap();
    store
        .run_schedule_once(&schedule.schedule_id, 1, "test-disabled", 120_000)
        .await
        .unwrap();
    assert_eq!(
        store
            .schedule(&schedule.schedule_id)
            .await
            .unwrap()
            .unwrap(),
        schedule
    );
    assert!(
        store
            .claim_schedule_occurrence(
                &schedule.schedule_id,
                1,
                120_000,
                "disabled-minute",
                120_000
            )
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn schedule_mutations_are_revision_and_idempotency_fenced() {
    let temp = TempDir::new().unwrap();
    let store = SqliteDomainStore::open(temp.path().join("state.sqlite"))
        .await
        .unwrap();
    let request = put_request();
    let first = store
        .put_schedule(&request, 1_700_000_000_000)
        .await
        .unwrap();
    assert_eq!(first.revision, 1);
    assert_eq!(
        store
            .put_schedule(&request, 1_700_000_000_001)
            .await
            .unwrap(),
        first
    );

    let mut changed_replay = request.clone();
    changed_replay.name = "Changed".into();
    assert!(matches!(
        store.put_schedule(&changed_replay, 1_700_000_000_002).await,
        Err(DomainStoreErrorV1::IdempotencyConflict { .. })
    ));

    let mut stale_update = request.clone();
    stale_update.idempotency_key = "schedule-put-2".into();
    assert!(matches!(
        store.put_schedule(&stale_update, 1_700_000_000_003).await,
        Err(DomainStoreErrorV1::IdentityConflict {
            entity: "schedule",
            ..
        })
    ));
}

#[tokio::test]
async fn occurrence_claim_survives_reopen_and_converges_on_one_terminal_receipt() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("state.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    let schedule = store
        .put_schedule(&put_request(), 1_700_000_000_000)
        .await
        .unwrap();
    let scheduled_for_ms = 1_700_000_040_000;
    let key = "schedule:morning-triage:1700000040000";
    let first = store
        .claim_schedule_occurrence(
            &schedule.schedule_id,
            schedule.revision,
            scheduled_for_ms,
            key,
            scheduled_for_ms,
        )
        .await
        .unwrap()
        .unwrap();
    let replay = store
        .claim_schedule_occurrence(
            &schedule.schedule_id,
            schedule.revision,
            scheduled_for_ms,
            key,
            scheduled_for_ms + 1,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(replay, first);
    store.close().await;

    let reopened = SqliteDomainStore::open(&path).await.unwrap();
    let pending = reopened.pending_schedule_occurrences(16).await.unwrap();
    assert_eq!(pending, vec![first]);
    let completed = reopened
        .finish_schedule_launch(key, Some("spawn-operation-1"), None, scheduled_for_ms + 2)
        .await
        .unwrap();
    assert_eq!(completed.launch_state, ScheduleLaunchStateV1::Started);
    assert_eq!(
        reopened
            .finish_schedule_launch(key, Some("spawn-operation-1"), None, scheduled_for_ms + 3,)
            .await
            .unwrap(),
        completed
    );
    assert!(
        reopened
            .pending_schedule_occurrences(16)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        reopened.schedule_occurrences(None, 16).await.unwrap(),
        vec![completed]
    );
}

#[tokio::test]
async fn deleted_schedule_cannot_admit_a_new_occurrence() {
    let temp = TempDir::new().unwrap();
    let store = SqliteDomainStore::open(temp.path().join("state.sqlite"))
        .await
        .unwrap();
    let schedule = store
        .put_schedule(&put_request(), 1_700_000_000_000)
        .await
        .unwrap();
    let deleted = store
        .delete_schedule(
            &ScheduleDeleteRequestV1 {
                schema_version: 1,
                schedule_id: schedule.schedule_id.clone(),
                expected_revision: schedule.revision,
                idempotency_key: "schedule-delete-1".into(),
            },
            schedule.updated_at_ms + 1,
        )
        .await
        .unwrap();
    assert_eq!(deleted.revision, 2);
    assert!(
        store
            .schedule(&schedule.schedule_id)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .claim_schedule_occurrence(
                &schedule.schedule_id,
                deleted.revision,
                1_700_000_040_000,
                "schedule:morning-triage:1700000040000",
                1_700_000_040_000,
            )
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn failed_occurrences_compact_without_reopening_old_admission() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("state.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    let schedule = store
        .put_schedule(&put_request(), 1_700_000_000_000)
        .await
        .unwrap();
    let first_minute = 1_700_000_040_000;
    let pending_key = "schedule-run-pending";
    store
        .claim_schedule_occurrence(
            &schedule.schedule_id,
            schedule.revision,
            first_minute,
            pending_key,
            first_minute,
        )
        .await
        .unwrap()
        .unwrap();

    for index in 1..=258_i64 {
        let scheduled_for_ms = first_minute + index * 60_000;
        let idempotency_key = format!("schedule-run-{index}");
        store
            .claim_schedule_occurrence(
                &schedule.schedule_id,
                schedule.revision,
                scheduled_for_ms,
                &idempotency_key,
                scheduled_for_ms,
            )
            .await
            .unwrap()
            .unwrap();
        store
            .finish_schedule_launch(
                &idempotency_key,
                None,
                Some("provider-exited"),
                scheduled_for_ms + 1,
            )
            .await
            .unwrap();
    }

    let counts: (i64, i64) = sqlx::query_as(
        "SELECT COUNT(*), SUM(state = 'pending') FROM schedule_occurrences WHERE schedule_id = ?1",
    )
    .bind(schedule.schedule_id.as_str())
    .fetch_one(&store.pool)
    .await
    .unwrap();
    assert_eq!(counts, (257, 1));
    store.close().await;

    let reopened = SqliteDomainStore::open(&path).await.unwrap();
    let pending = reopened.pending_schedule_occurrences(16).await.unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].0.trigger.scheduled_for_ms(), Some(first_minute));

    let pruned_minute = first_minute + 60_000;
    assert!(
        reopened
            .claim_schedule_occurrence(
                &schedule.schedule_id,
                schedule.revision,
                pruned_minute,
                "schedule-run-1",
                first_minute + 259 * 60_000,
            )
            .await
            .unwrap()
            .is_none()
    );
    sqlx::query(
        r#"
        CREATE TRIGGER fail_schedule_occurrence_compaction
        BEFORE DELETE ON schedule_occurrences
        BEGIN
            SELECT RAISE(ABORT, 'injected schedule compaction failure');
        END
        "#,
    )
    .execute(&reopened.pool)
    .await
    .unwrap();
    assert!(
        reopened
            .finish_schedule_launch(
                pending_key,
                None,
                Some("provider-exited"),
                first_minute + 259 * 60_000,
            )
            .await
            .is_err()
    );
    let state: String = sqlx::query_scalar(
        "SELECT state FROM schedule_occurrences WHERE schedule_id = ?1 AND scheduled_for_ms = ?2",
    )
    .bind(schedule.schedule_id.as_str())
    .bind(first_minute)
    .fetch_one(&reopened.pool)
    .await
    .unwrap();
    assert_eq!(state, "pending");
    sqlx::query("DROP TRIGGER fail_schedule_occurrence_compaction")
        .execute(&reopened.pool)
        .await
        .unwrap();
    reopened
        .finish_schedule_launch(
            pending_key,
            None,
            Some("provider-exited"),
            first_minute + 259 * 60_000,
        )
        .await
        .unwrap();

    let recent = reopened
        .schedule_occurrences(Some(&schedule.schedule_id), 256)
        .await
        .unwrap();
    assert_eq!(recent.len(), 256);
    assert_eq!(recent[0].launch_state, ScheduleLaunchStateV1::Failed);
    assert_eq!(recent[0].error_code.as_deref(), Some("provider-exited"));
    assert_eq!(recent[1].launch_state, ScheduleLaunchStateV1::Failed);
    assert!(
        reopened
            .pending_schedule_occurrences(16)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn schema_twenty_backfills_admission_before_compacting_terminal_rows() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("state.sqlite");
    let store = SqliteDomainStore::open(&path).await.unwrap();
    let schedule = store
        .put_schedule(&put_request(), 1_700_000_000_000)
        .await
        .unwrap();
    store.close().await;

    let options = SqliteConnectOptions::new().filename(&path);
    let mut legacy = SqliteConnection::connect_with(&options).await.unwrap();
    sqlx::query("DROP INDEX schedule_occurrences_pending_idx")
        .execute(&mut legacy)
        .await
        .unwrap();
    sqlx::query("DROP TABLE schedule_occurrences")
        .execute(&mut legacy)
        .await
        .unwrap();
    sqlx::query(crate::schedule_schema::CREATE_SCHEDULE_OCCURRENCES)
        .execute(&mut legacy)
        .await
        .unwrap();
    sqlx::query("ALTER TABLE schedules DROP COLUMN admitted_through_ms")
        .execute(&mut legacy)
        .await
        .unwrap();
    downgrade_workflow_launch_fixture_to_v31(&mut legacy)
        .await
        .unwrap();
    crate::migration_test_support::remove_post_v32_dispatch_stop_storage(&mut legacy).await;
    sqlx::query(
        "UPDATE store_metadata SET schema_version = 20, min_reader_version = 20, min_writer_version = 20 WHERE singleton = 1",
    )
    .execute(&mut legacy)
    .await
    .unwrap();
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut legacy)
        .await
        .unwrap();
    let template = serde_json::to_string(&put_request().run_template).unwrap();
    let first_minute = 1_700_000_040_000;
    for index in 1..=258_i64 {
        let scheduled_for_ms = first_minute + index * 60_000;
        sqlx::query(
            r#"
            INSERT INTO schedule_occurrences (
                schedule_id, scheduled_for_ms, schema_version, schedule_revision,
                idempotency_key, run_template_json, state, operation_id, error_code,
                created_at_ms, updated_at_ms
            ) VALUES (?1, ?2, 1, ?3, ?4, ?5, 'succeeded', ?6, NULL, ?2, ?7)
            "#,
        )
        .bind(schedule.schedule_id.as_str())
        .bind(scheduled_for_ms)
        .bind(i64::try_from(schedule.revision).unwrap())
        .bind(format!("legacy-run-{index}"))
        .bind(&template)
        .bind(format!("legacy-spawn-{index}"))
        .bind(scheduled_for_ms + 1)
        .execute(&mut legacy)
        .await
        .unwrap();
    }
    sqlx::query("COMMIT").execute(&mut legacy).await.unwrap();
    legacy.close().await.unwrap();

    let migrated = SqliteDomainStore::open(&path).await.unwrap();
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM schedule_occurrences WHERE schedule_id = ?1")
            .bind(schedule.schedule_id.as_str())
            .fetch_one(&migrated.pool)
            .await
            .unwrap();
    assert_eq!(count, 256);
    let admitted_through_ms: i64 =
        sqlx::query_scalar("SELECT admitted_through_ms FROM schedules WHERE schedule_id = ?1")
            .bind(schedule.schedule_id.as_str())
            .fetch_one(&migrated.pool)
            .await
            .unwrap();
    assert_eq!(admitted_through_ms, first_minute + 258 * 60_000);
    let index_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'schedule_occurrences_pending_idx'",
    )
    .fetch_one(&migrated.pool)
    .await
    .unwrap();
    assert_eq!(index_count, 1);
    assert!(
        migrated
            .claim_schedule_occurrence(
                &schedule.schedule_id,
                schedule.revision,
                first_minute + 60_000,
                "legacy-run-1",
                first_minute + 259 * 60_000,
            )
            .await
            .unwrap()
            .is_none()
    );
}
