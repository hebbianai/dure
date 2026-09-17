//! The mobile build must not contain the local-runtime world.
//!
//! This replaces `attach::tests::local_runtime_feature_split_is_still_unlanded`,
//! the tripwire that fired the moment `local-runtime` landed on main (3085f57).
//! The tripwire's own instructions were to verify the exclusion for real and
//! then delete it, and "for real" is the whole difficulty: the obvious check —
//! grepping this crate's `Cargo.toml` for `default-features = false` — asserts
//! an *intention*. Cargo unifies features across the whole graph, so one
//! dependency taking `hmux-client` with its defaults turns the world back on
//! while every `default-features = false` in this manifest still reads exactly
//! as it did.
//!
//! So the assertion is made against the **resolved** feature set that `cargo`
//! itself computed. `cargo metadata`'s `resolve.nodes[].features` is that
//! answer, and it is the same answer the compiler acts on.
//!
//! What being off actually excludes, by `#[cfg]` in the crates themselves:
//!
//! - `hmux-client`: `runtime_broker` (spawns an `hmux-runtime` subprocess),
//!   `managed_attach` / `managed_create` / `managed_stop` /
//!   `standalone_create` (the four broker facades),
//!   `legacy_terminate` (`libc::kill(-pgid)` against pids read from a
//!   manifest), `default_discovery_root` and `transport::unix_socket` (the
//!   filesystem dialer, and the only constructor that can mint a colocation
//!   witness).
//! - `hmux-host`: the session state machine and the terminal replay engine,
//!   plus `alacritty_terminal`.
//!
//! `alacritty_terminal`'s absence from the package graph is asserted too. It
//! is the one dependency edge that only the local-runtime half pulls in, so it
//! is a second, independent witness that does not rely on reading a feature
//! list correctly. `dirs` is deliberately *not* used that way: `tauri` and
//! `wry` both depend on it, so its presence proves nothing either direction.

use std::collections::BTreeSet;
use std::process::Command;

/// The feature whose absence is the whole point.
const LOCAL_RUNTIME: &str = "local-runtime";

/// Crates that must be present but lean.
const LEAN_CRATES: [&str; 2] = ["hmux-client", "hmux-host"];

/// Pulled in only by `hmux-host/local-runtime`. A phone renders frames it is
/// sent and hosts no PTY, so a terminal emulator in the graph means the split
/// leaked.
const LOCAL_RUNTIME_ONLY_PACKAGE: &str = "alacritty_terminal";

struct Metadata {
    /// Package name -> resolved feature set, for the crates under test.
    resolved_features: Vec<(String, BTreeSet<String>)>,
    package_names: BTreeSet<String>,
}

fn metadata() -> Metadata {
    // `CARGO` is set by cargo for anything it runs, so this is the same
    // toolchain that built the crate under test rather than whatever `cargo`
    // happens to be first on `PATH`.
    let cargo = std::env::var("CARGO").expect("cargo sets CARGO for its test binaries");
    let manifest = concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml");
    let output = Command::new(cargo)
        .args(["metadata", "--format-version", "1", "--manifest-path"])
        .arg(manifest)
        .output()
        .expect("cargo metadata must run");
    assert!(
        output.status.success(),
        "cargo metadata failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let document: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("cargo metadata emits JSON");

    // Package ids are opaque and their spelling has changed between cargo
    // releases (`path+file:///…#hmux-client@0.1.4` and
    // `…/hmux-client#0.1.4` are both in the wild). So the id is never parsed:
    // `packages[].name` gives the authoritative name for an id, and the
    // resolve node is then found by that exact id.
    let packages = document["packages"]
        .as_array()
        .expect("packages is an array");
    let package_names: BTreeSet<String> = packages
        .iter()
        .map(|package| {
            package["name"]
                .as_str()
                .expect("a package name")
                .to_string()
        })
        .collect();

    let mut resolved_features = Vec::new();
    for crate_name in LEAN_CRATES {
        let Some(id) = packages
            .iter()
            .find(|package| package["name"].as_str() == Some(crate_name))
            .and_then(|package| package["id"].as_str())
        else {
            continue;
        };
        let node = document["resolve"]["nodes"]
            .as_array()
            .expect("resolve.nodes is an array")
            .iter()
            .find(|node| node["id"].as_str() == Some(id))
            .unwrap_or_else(|| panic!("{crate_name} has a package entry but no resolve node"));
        let features = node["features"]
            .as_array()
            .expect("features is an array")
            .iter()
            .map(|feature| feature.as_str().expect("a feature name").to_string())
            .collect();
        resolved_features.push((crate_name.to_string(), features));
    }

    Metadata {
        resolved_features,
        package_names,
    }
}

#[test]
fn the_mobile_build_resolves_hmux_crates_without_local_runtime() {
    let metadata = metadata();

    for crate_name in LEAN_CRATES {
        let (_, features) = metadata
            .resolved_features
            .iter()
            .find(|(name, _)| name == crate_name)
            .unwrap_or_else(|| panic!("{crate_name} is not in the mobile dependency graph at all"));
        assert!(
            !features.contains(LOCAL_RUNTIME),
            "{crate_name} resolved with `{LOCAL_RUNTIME}` enabled ({features:?}). Something in \
             this graph takes it with default features, so the broker subprocess spawner, the \
             filesystem discovery root and the manifest-pid signalling are compiled into a phone \
             build."
        );
    }
}

/// A second witness that does not depend on reading a feature list correctly.
#[test]
fn the_terminal_replay_engine_is_not_in_the_mobile_dependency_graph() {
    let metadata = metadata();

    assert!(
        !metadata.package_names.contains(LOCAL_RUNTIME_ONLY_PACKAGE),
        "{LOCAL_RUNTIME_ONLY_PACKAGE} is in the mobile graph. Only hmux-host's `local-runtime` \
         feature pulls it in, so the split has leaked."
    );
}

/// Guards the test above from becoming vacuous.
///
/// Both assertions are negative, so a typo in a crate name, a renamed feature
/// or a metadata shape change would make them pass while proving nothing. This
/// asserts the positive half: the crates really are in the graph, and the
/// feature name really is one `hmux-client` declares.
#[test]
fn the_crates_under_test_are_actually_present_and_declare_the_feature() {
    let metadata = metadata();

    for crate_name in LEAN_CRATES {
        assert!(
            metadata.package_names.contains(crate_name),
            "{crate_name} is not a package in this graph; the checks above assert nothing"
        );
    }

    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../hmux/crates/hmux-client/Cargo.toml");
    let text = std::fs::read_to_string(&manifest)
        .unwrap_or_else(|error| panic!("read {}: {error}", manifest.display()));
    assert!(
        text.contains(LOCAL_RUNTIME),
        "hmux-client no longer declares a `{LOCAL_RUNTIME}` feature; the exclusion checks above \
         are now asserting the absence of something that cannot exist. Re-derive what the mobile \
         build must exclude before deleting them."
    );
}
