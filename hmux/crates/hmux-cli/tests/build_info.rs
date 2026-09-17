use std::process::Command;

#[test]
fn capabilities_json_exposes_exact_public_build_info() {
    let output = Command::new(env!("CARGO_BIN_EXE_hmux"))
        .args(["capabilities", "--json"])
        .output()
        .expect("run hmux capabilities");
    assert!(output.status.success());

    let payload: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("capabilities JSON");
    assert_eq!(payload["schemaVersion"], 2);
    assert_eq!(payload["buildInfo"]["source"], "hmux_cli");
    assert_eq!(payload["buildInfo"]["buildId"], env!("HMUX_BUILD_ID"));
    assert_eq!(payload["buildInfo"]["platform"]["os"], std::env::consts::OS);
    assert_eq!(
        payload["buildInfo"]["platform"]["arch"],
        std::env::consts::ARCH
    );
    assert_eq!(payload["buildInfo"]["protocol"]["minimum"], "1.0");
    assert_eq!(payload["buildInfo"]["protocol"]["maximum"], "1.0");
    assert!(
        payload["capabilities"]
            .as_array()
            .expect("capabilities array")
            .iter()
            .any(|capability| capability == "pairing_v1")
    );
}
