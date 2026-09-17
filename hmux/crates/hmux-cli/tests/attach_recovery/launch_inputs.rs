use super::*;

pub(super) fn assert_recovery_preserves_launch_inputs() {
    let policy = idle_retirement_policy();
    let colors = TerminalDefaultColors::new(0x123456, 0x789abc).unwrap();
    let fixture = StaleFixture::safe_shell_with_retirement_policy("policy-dev", policy, colors);

    let output = run_attach(&fixture.discovery_root, "policy-dev");
    assert!(
        output.status.success(),
        "attach failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let replacement = fixture
        .catalog()
        .list()
        .unwrap()
        .into_iter()
        .find(|session| {
            session.session_name.as_deref() == Some("policy-dev")
                && session.session_id != fixture.source_session_id
        })
        .expect("recovered policy session is missing");
    let recovery_record: Value =
        serde_json::from_slice(&fs::read(recovery_record_path(&fixture.discovery_root)).unwrap())
            .unwrap();
    let prepared_request: StandaloneCreateRequest = serde_json::from_str(
        recovery_record["operation_checkpoint"]["canonicalPayload"]
            .as_str()
            .expect("prepared create request is missing"),
    )
    .unwrap();

    assert_eq!(prepared_request.retirement_policy(), Some(policy));
    assert_eq!(replacement.retirement_policy, Some(policy));
    assert_eq!(
        prepared_request.retirement_policy(),
        replacement.retirement_policy
    );
    assert_eq!(
        prepared_request.terminal_default_colors(),
        Some(colors),
        "the durable recovery input must retain the complete terminal launch request"
    );
}
