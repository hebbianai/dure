use super::*;
use hmux_client::inspect_local_session;

#[test]
fn gateway_v3_abandons_an_idle_creation_that_was_never_presented() {
    let readiness = tempfile::tempdir().unwrap();
    let ready = readiness.path().join("provider-ready");
    let fixture = Fixture::start_with_provider(&format!(
        "printf ready > {}; IFS= read -r line",
        shell_quote(&ready)
    ));
    wait_until_exists(&ready);
    let response = fixture.abandon_unpresented_creation("abandon-idle-creation");

    assert_eq!(response["gateway_abandon_version"], 1);
    assert_eq!(response["request_id"], "abandon-idle-creation");
    assert_eq!(response["session_id"], fixture.descriptor.session_id);
    assert_eq!(response["workspace_id"], fixture.descriptor.workspace_id);
    assert_eq!(
        response["receipt"]["state"], "retirement_armed",
        "unexpected abandon receipt: {response}"
    );
    assert!(response["receipt"]["reason"].is_null());
    assert!(
        !response.to_string().contains(&fixture.launch_owner_proof),
        "the launch-owner proof must never be echoed in a receipt"
    );

    fixture.wait_until_exited();
}

#[test]
fn gateway_v3_preserves_a_creation_after_an_observer_attached_then_closed() {
    let fixture = Fixture::start();
    let observer = fixture
        .session
        .connect(LocalAttachRole::Observer, None)
        .expect("the pre-presentation observer attach succeeds");
    observer.shutdown();
    drop(observer);

    let response = fixture.abandon_unpresented_creation("abandon-after-observer");

    assert_eq!(response["gateway_abandon_version"], 1);
    assert_eq!(response["request_id"], "abandon-after-observer");
    assert_eq!(response["receipt"]["state"], "session_preserved");
    assert_eq!(
        response["receipt"]["reason"], "other_clients_attached",
        "an EOF must not erase the Host's committed attach history"
    );
    assert_eq!(
        probe_local_session_exact_until(
            &fixture.catalog,
            &fixture.descriptor,
            Instant::now() + FRAME_TIMEOUT,
        ),
        SessionProbeStatus::Healthy,
        "a refused abandon must leave the exact Host generation attachable"
    );
}

#[test]
fn inspecting_an_unpresented_creation_preserves_its_abandonment() {
    let readiness = tempfile::tempdir().unwrap();
    let ready = readiness.path().join("provider-ready");
    let fixture = Fixture::start_with_provider(&format!(
        "printf ready > {}; IFS= read -r line",
        shell_quote(&ready)
    ));
    wait_until_exists(&ready);

    assert_eq!(
        probe_local_session_exact(&fixture.catalog, &fixture.descriptor),
        SessionProbeStatus::Healthy
    );
    assert_eq!(
        inspect_local_session(&fixture.catalog, fixture.descriptor.clone()).probe_status(),
        Some(SessionProbeStatus::Healthy)
    );
    let response = fixture.abandon_unpresented_creation("abandon-after-inspection");
    assert_eq!(
        response["receipt"]["state"], "retirement_armed",
        "inspection must not publish a user attachment: {response}"
    );
    assert!(response["receipt"]["reason"].is_null());
    fixture.wait_until_exited();
}

#[test]
fn inspecting_a_departed_session_does_not_cancel_its_retirement() {
    let readiness = tempfile::tempdir().unwrap();
    let ready = readiness.path().join("provider-ready");
    let fixture = Fixture::start_with_provider_and_retirement(
        &format!("printf ready > {}; IFS= read -r line", shell_quote(&ready)),
        Some(
            SessionRetirementPolicy::AfterGracefulLastClientDepartureV1 {
                grace_period_ms: 1_000,
            },
        ),
    );
    wait_until_exists(&ready);
    assert_eq!(
        fixture.session.depart_gracefully().unwrap().state,
        SessionRetirementReceiptState::RetirementArmed
    );
    // Observe during the grace period. A normal attachment would cancel it;
    // an inspection must leave the Host's existing deadline in charge.
    assert_eq!(
        inspect_local_session(&fixture.catalog, fixture.descriptor.clone()).probe_status(),
        Some(SessionProbeStatus::Healthy)
    );
    fixture.wait_until_exited();
}
