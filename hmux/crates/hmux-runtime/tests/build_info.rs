use std::process::Command;

#[test]
fn build_info_exposes_the_compiled_product_profile() {
    let runtime = env!("CARGO_BIN_EXE_hmux-runtime");
    let output = Command::new(runtime)
        .args(["--no-autostart", "hmux-build-info"])
        .output()
        .expect("run hmux-runtime build info");
    assert!(output.status.success());

    let payload: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("build info JSON");
    #[cfg(feature = "terminal-state-stream")]
    let expected = "structured-terminal-v1";
    #[cfg(not(feature = "terminal-state-stream"))]
    let expected = "runtime-core-v1";
    assert_eq!(payload["productProfile"], expected);
    assert!(
        payload["capabilities"]
            .as_array()
            .is_some_and(|capabilities| capabilities.iter().any(|capability| {
                capability == hmux_runtime_contract::MANAGED_CREATE_ADVANCE_CAPABILITY
            }))
    );
    assert!(
        payload["capabilities"]
            .as_array()
            .is_some_and(|capabilities| capabilities.iter().any(|capability| {
                capability == hmux_runtime_contract::MANAGED_CREATE_CHAIN_STOP_CAPABILITY
            }))
    );
    assert!(
        payload["capabilities"]
            .as_array()
            .is_some_and(|capabilities| capabilities.iter().any(|capability| {
                capability == hmux_runtime_contract::MANAGED_CREATE_CHAIN_STOP_CAPABILITY_V2
            }))
    );

    for capability in [
        hmux_runtime_contract::MANAGED_CREATE_CAPABILITY,
        hmux_host::local_protocol::AGENT_STATE_REPORT_CAUSALITY_CAPABILITY,
        #[cfg(unix)]
        hmux_runtime_contract::STANDALONE_REQUEST_BOUND_CREATE_CAPABILITY,
    ] {
        assert!(
            payload["capabilities"]
                .as_array()
                .unwrap()
                .iter()
                .any(|value| value == capability)
        );
    }

    let binary = std::fs::read(runtime).expect("read runtime binary");
    let marker = format!("hmux-product-profile={expected}");
    assert!(
        binary
            .windows(marker.len())
            .any(|window| window == marker.as_bytes()),
        "runtime binary has no compiled product-profile marker"
    );
}
