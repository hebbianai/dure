use super::*;

#[tokio::test]
async fn saved_slack_ingress_starts_only_after_canonical_authority_and_uses_backend_dispatch() {
    let (root, mut state, _, _) = fixture(Vec::new()).await;
    make_fixture_mutation_authority(&mut state);
    let cli = root.path().join("dure.mjs");
    fs::write(
        &cli,
        "#!/bin/sh\nprintf '%s\\n' '{\"event\":\"slack.connected\"}'\ncat > /dev/null\n",
    )
    .unwrap();
    fs::set_permissions(&cli, fs::Permissions::from_mode(0o700)).unwrap();
    let state = Arc::new(state);
    let connected = request_over_test_connection(Arc::clone(&state), "slack.connector", "slack.connector.v1",
        json!({ "schemaVersion": 1, "kind": "connect", "config": { "schemaVersion": 1, "teamId": "T1", "channels": [] } })).await;
    assert_eq!(connected["kind"], BACKEND_RESPONSE_KIND);
    state.slack.shutdown().await.unwrap();
    let mut state = Arc::try_unwrap(state)
        .ok()
        .expect("connection handler completed");
    state.slack = crate::slack_connector::SlackConnectorService::new(
        ensure_backend_root(root.path()).unwrap().durable(),
        root.path(),
        cli,
        state.hmux_identity.clone(),
    );
    fs::remove_file(&state.canonical_descriptor_path).unwrap();
    let state = Arc::new(state);
    let mut restoring = tokio::spawn(crate::slack_connector::restore_when_active(Arc::clone(
        &state,
    )));
    assert!(
        tokio::time::timeout(Duration::from_millis(150), &mut restoring)
            .await
            .is_err()
    );
    let waiting = state
        .slack
        .dispatch(&json!({ "schemaVersion": 1, "kind": "list" }))
        .await
        .unwrap();
    assert_eq!(waiting["connections"][0]["generation"], Value::Null);
    write_descriptor(&state.canonical_descriptor_path, &state.descriptor).unwrap();
    tokio::time::timeout(Duration::from_secs(5), restoring)
        .await
        .unwrap()
        .unwrap();
    let active = request_over_test_connection(
        Arc::clone(&state),
        "slack.connector",
        "slack.connector.v1",
        json!({ "schemaVersion": 1, "kind": "list" }),
    )
    .await;
    assert!(active["result"]["connections"][0]["generation"].is_string());
    state.slack.shutdown().await.unwrap();
}
