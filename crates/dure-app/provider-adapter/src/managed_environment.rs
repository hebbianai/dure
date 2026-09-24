//! Dure-owned process routing, independent of the Hmux broker's environment.
//! Provider authentication, user tool configuration and isolation roots survive.

/// Ambient launcher/build state must not select a different app or runtime in
/// the provider's descendants. The caller binds DURE_APP_CHANNEL explicitly.
pub const INHERITED_LAUNCH_KEYS: &[&str] = &[
    "DURE_APP_CHANNEL",
    "HEBBIAN_APP_CHANNEL",
    "DURE_HMUX_BIN",
    "HEBBIAN_HMUX_BIN",
    "DURE_HMUX_RUNTIME_BIN",
    "HMUX_RUNTIME",
    "HEBBIAN_HMUX_RUNTIME",
    "DURE_BUILD_ID",
    "DURE_DEV_LAUNCH_GENERATION",
    "DURE_BACKEND_RUNTIME_FINGERPRINT",
    "HMUX_INSTALL_DIR",
    "HMUX_INSTALL_ROOT",
    "HMUX_INSTALL_LOCK_WAIT_SECONDS",
    "TAURI_CONFIG",
    "INIT_CWD",
    "OUT_DIR",
    "CARGO_MANIFEST_DIR",
    "CARGO_MANIFEST_PATH",
    "CARGO_PKG_NAME",
    "CARGO_PKG_VERSION",
    "CARGO_PKG_VERSION_MAJOR",
    "CARGO_PKG_VERSION_MINOR",
    "CARGO_PKG_VERSION_PATCH",
    "CARGO_PKG_VERSION_PRE",
    "CARGO_CRATE_NAME",
    "CARGO_PRIMARY_PACKAGE",
    "npm_lifecycle_event",
    "npm_lifecycle_script",
    "npm_package_json",
    "npm_package_name",
    "npm_package_version",
    "npm_execpath",
    "npm_node_execpath",
];

/// Unix desktop/control-plane adapters use the same argv prefix. No provider
/// credentials or caller-provided strings are interpolated into shell source.
pub fn unix_managed_environment_prefix(channel: &str) -> Vec<String> {
    vec![
        "/bin/sh".into(),
        "-c".into(),
        format!(
            "unset {}; export DURE_APP_CHANNEL=\"$1\"; shift; exec \"$@\"",
            INHERITED_LAUNCH_KEYS.join(" ")
        ),
        "dure-managed-environment".into(),
        channel.into(),
    ]
}
