use super::*;

async fn claim_request(state: &Arc<ServiceState>, operation: &str, body: Value) -> Value {
    request_over_test_connection(Arc::clone(state), operation, "work_claim.v1", body).await
}

fn claim(holder: &str, issue: &str, paths: &[&str]) -> Value {
    json!({
        "repository": "/work/repo/.git",
        "holder": holder,
        "sessionId": format!("session-{holder}"),
        "issue": issue,
        "branch": format!("agent/{holder}"),
        "paths": paths,
    })
}

#[tokio::test]
async fn claims_are_declared_listed_checked_and_released_over_the_backend_wire() {
    let (_root, mut state, _launcher, _prompt_deliverer) = fixture(Vec::new()).await;
    make_fixture_mutation_authority(&mut state);
    let state = Arc::new(state);

    let first = claim_request(
        &state,
        "work_claim.put",
        json!({ "schemaVersion": 1, "claim": claim("engine-1", "2", &["Sources/Engine/**"]) }),
    )
    .await;
    assert_eq!(first["kind"], BACKEND_RESPONSE_KIND, "{first}");
    assert_eq!(first["result"]["recorded"], true);
    assert_eq!(first["result"]["overlaps"], json!([]));
    assert_eq!(first["result"]["claim"]["claim"]["holder"], "engine-1");

    let check = claim_request(
        &state,
        "work_claim.put",
        json!({
            "schemaVersion": 1,
            "claim": claim("engine-2", "3", &["Sources/Engine/Core/A.swift", "Sources/UI"]),
            "dryRun": true,
        }),
    )
    .await;
    assert_eq!(check["result"]["recorded"], false, "{check}");
    assert_eq!(
        check["result"]["overlaps"],
        json!([{
            "held": first["result"]["claim"],
            "reasons": ["paths"],
            "paths": [{ "mine": "Sources/Engine/Core/A.swift", "theirs": "Sources/Engine/**" }],
        }])
    );

    let listed = claim_request(&state, "work_claim.list", json!({ "schemaVersion": 1 })).await;
    assert_eq!(
        listed["result"],
        json!({ "schemaVersion": 1, "claims": [first["result"]["claim"]], "complete": true })
    );
    let other_repository = claim_request(
        &state,
        "work_claim.list",
        json!({ "schemaVersion": 1, "repository": "/work/other/.git" }),
    )
    .await;
    assert_eq!(other_repository["result"]["claims"], json!([]));

    let released = claim_request(
        &state,
        "work_claim.release",
        json!({ "schemaVersion": 1, "repository": "/work/repo/.git", "holder": "engine-1" }),
    )
    .await;
    assert_eq!(released["result"]["released"], first["result"]["claim"]);
    let again = claim_request(
        &state,
        "work_claim.release",
        json!({ "schemaVersion": 1, "repository": "/work/repo/.git", "holder": "engine-1" }),
    )
    .await;
    assert_eq!(again["result"]["released"], Value::Null);
}

#[tokio::test]
async fn invalid_claims_are_refused_as_terminal_with_the_reason() {
    let (_root, mut state, _launcher, _prompt_deliverer) = fixture(Vec::new()).await;
    make_fixture_mutation_authority(&mut state);
    let state = Arc::new(state);
    for body in [
        json!({ "schemaVersion": 1, "claim": claim("engine-1", "2", &["/etc/passwd"]) }),
        json!({ "schemaVersion": 1, "claim": { "repository": "/work/repo/.git", "holder": "engine-1" } }),
        json!({ "schemaVersion": 1, "claim": claim("engine-1", "2", &[]), "unknown": true }),
        json!({ "schemaVersion": 2, "claim": claim("engine-1", "2", &[]) }),
    ] {
        let response = claim_request(&state, "work_claim.put", body).await;
        assert_eq!(response["kind"], BACKEND_ERROR_KIND, "{response}");
        assert_eq!(response["error"]["code"], "work_claim_request_invalid");
        assert_eq!(response["error"]["details"]["disposition"], "terminal");
    }
    let listed = claim_request(&state, "work_claim.list", json!({ "schemaVersion": 1 })).await;
    assert_eq!(listed["result"]["claims"], json!([]));
}
