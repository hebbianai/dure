use super::*;

async fn prohibit_domain_writes(root: &TempDir) -> sqlx::SqlitePool {
    let pool = sqlx::SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(root.path().join("domain.sqlite")),
    )
    .await
    .unwrap();
    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    for (index, table) in tables.iter().enumerate() {
        for action in ["INSERT", "UPDATE", "DELETE"] {
            sqlx::query(&format!(
                "CREATE TRIGGER canary_guard_{index}_{action} BEFORE {action} ON \"{}\" \
                 BEGIN SELECT RAISE(ABORT, 'event canary attempted a domain write'); END",
                table.replace('"', "\"\"")
            ))
            .execute(&pool)
            .await
            .unwrap();
        }
    }
    pool
}

#[tokio::test]
async fn event_canary_reads_queued_deliveries_with_all_domain_writes_prohibited() {
    let (root, state, launcher, prompt_deliverer) = fixture(Vec::new()).await;
    let (_context, session) = prepare_exact_session_run(&state).await;
    let _write_guard = prohibit_domain_writes(&root).await;
    let body = json!({"schemaVersion": 1, "session": session, "after": 0, "limit": 10});
    for _ in 0..2 {
        let result = invoke_orchestration(
            &state,
            "event-canary",
            "events.inspect.exact-session",
            body.clone(),
        )
        .await;
        assert_eq!(result["receipt"]["eventCount"], 1);
        assert_eq!(result["receipt"]["deliveryStates"]["queued"], 1);
        assert_eq!(result["receipt"]["observation"], "events_available");
        assert_eq!(
            result["receipt"]["apiVersion"],
            "dure.orchestration-event-observation/v1"
        );
        assert!(result["receipt"].get("events").is_none());
        assert!(result["receipt"].get("endpointFence").is_none());
    }
    let mut empty_body = body;
    empty_body["after"] = json!(1);
    let empty = invoke_orchestration(
        &state,
        "event-canary-empty",
        "events.inspect.exact-session",
        empty_body,
    )
    .await;
    assert_eq!(empty["receipt"]["observation"], "empty");
    assert_eq!(empty["receipt"]["nextCursor"], 1);
    assert_eq!(empty["receipt"]["eventCount"], 0);
    assert!(launcher.requests().is_empty());
    assert!(prompt_deliverer.requests().is_empty());
}

#[tokio::test]
async fn event_canary_rejects_stale_and_mutating_requests_without_domain_writes() {
    let (root, state, launcher, prompt_deliverer) = fixture(Vec::new()).await;
    let (_context, session) = prepare_exact_session_run(&state).await;
    let _write_guard = prohibit_domain_writes(&root).await;
    let body = json!({"schemaVersion": 1, "session": session, "after": 0, "limit": 10});
    for (field, value) in [
        ("acknowledgement", json!({"through": 1})),
        ("schemaVersion", json!(2)),
        ("limit", json!(0)),
        ("limit", json!(129)),
        ("after", json!(-1)),
    ] {
        let mut invalid = body.clone();
        invalid[field] = value;
        let error = dispatch(
            &state,
            &orchestration_backend_request(
                &state,
                "canary-invalid",
                "events.inspect.exact-session",
                invalid,
            ),
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "orchestration_request_invalid");
        assert_eq!(error.disposition, BackendFailureDispositionV1::Terminal);
    }
    let mut stale = body;
    stale["session"]["terminalEpoch"] = json!("terminal-replaced");
    let error = dispatch(
        &state,
        &orchestration_backend_request(
            &state,
            "canary-stale",
            "events.inspect.exact-session",
            stale,
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "orchestration_generation_conflict");
    assert_eq!(
        error.disposition,
        BackendFailureDispositionV1::StaleGeneration
    );
    assert!(launcher.requests().is_empty());
    assert!(prompt_deliverer.requests().is_empty());
}

#[tokio::test]
async fn event_canary_does_not_enroll_an_unassigned_session() {
    let (root, state, launcher, prompt_deliverer) = fixture(Vec::new()).await;
    let _write_guard = prohibit_domain_writes(&root).await;
    let body = json!({"schemaVersion": 1, "session": existing_session_run_body()["session"], "after": 0, "limit": 10});
    let session = serde_json::from_value(body["session"].clone()).unwrap();
    verify_exact_orchestration_session(&state, &session)
        .await
        .unwrap();
    let error = dispatch(
        &state,
        &orchestration_backend_request(
            &state,
            "canary-unassigned",
            "events.inspect.exact-session",
            body,
        ),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "orchestration_generation_conflict");
    assert_eq!(
        error.disposition,
        BackendFailureDispositionV1::StaleGeneration
    );
    assert!(
        state
            .store
            .inspect_orchestration_dispatch_session(&session)
            .await
            .unwrap()
            .target
            .is_none()
    );
    assert!(launcher.requests().is_empty());
    assert!(prompt_deliverer.requests().is_empty());
}
