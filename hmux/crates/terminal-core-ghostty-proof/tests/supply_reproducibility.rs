#![cfg(feature = "supply-stage")]

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use terminal_core_ghostty_proof::supply::{StagedSupply, run_cli};

const TARGETS: &[&str] = &["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl"];

#[test]
#[ignore = "requires the reviewed Ghostty source and Zig provenance closure"]
fn distinct_output_roots_produce_identical_linux_artifacts() {
    let input = PathBuf::from(
        std::env::var_os("HMUX_GHOSTTY_SUPPLY_INPUT_ROOT")
            .expect("HMUX_GHOSTTY_SUPPLY_INPUT_ROOT must name the reviewed artifact root"),
    );
    let output = tempfile::tempdir().expect("create distinct supply output roots");

    for target in TARGETS {
        let first_output = output.path().join(format!("{target}-first"));
        let second_output = output.path().join(format!("{target}-second"));
        let (first, second) = std::thread::scope(|scope| {
            let first = scope.spawn(|| stage(&input, target, &first_output));
            let second = scope.spawn(|| stage(&input, target, &second_output));
            (
                first.join().expect("first supply caller panicked"),
                second.join().expect("second supply caller panicked"),
            )
        });

        assert_eq!(
            first.recipe_id, second.recipe_id,
            "recipe changed for {target}"
        );
        assert_eq!(
            first.artifact_id, second.artifact_id,
            "artifact identity changed for {target}"
        );
        assert_eq!(
            fs::read(first.artifact_root.join("lib/libghostty-vt.a")).expect("read first library"),
            fs::read(second.artifact_root.join("lib/libghostty-vt.a"))
                .expect("read second library"),
            "library bytes changed for {target}"
        );
        assert_eq!(
            fs::read(first.artifact_root.join("hmux-ghostty-vt-proof.receipt"))
                .expect("read first receipt"),
            fs::read(second.artifact_root.join("hmux-ghostty-vt-proof.receipt"))
                .expect("read second receipt"),
            "receipt bytes changed for {target}"
        );
    }
}

#[test]
#[ignore = "requires the reviewed Ghostty source and Zig provenance closure"]
fn distinct_output_roots_produce_identical_windows_artifacts() {
    let input = PathBuf::from(
        std::env::var_os("HMUX_GHOSTTY_SUPPLY_INPUT_ROOT")
            .expect("HMUX_GHOSTTY_SUPPLY_INPUT_ROOT must name the reviewed artifact root"),
    );
    let output = tempfile::tempdir().expect("create distinct supply output roots");
    let target = "x86_64-pc-windows-msvc";
    let first_output = output.path().join("windows-first");
    let second_output = output.path().join("windows-second");
    let (first, second) = std::thread::scope(|scope| {
        let first = scope.spawn(|| stage(&input, target, &first_output));
        let second = scope.spawn(|| stage(&input, target, &second_output));
        (
            first.join().expect("first Windows supply caller panicked"),
            second
                .join()
                .expect("second Windows supply caller panicked"),
        )
    });

    assert_eq!(first.recipe_id, second.recipe_id, "Windows recipe changed");
    assert_eq!(
        first.artifact_id, second.artifact_id,
        "Windows artifact identity changed"
    );
    for relative in [
        "lib/ghostty-vt-static.lib",
        "lib/hmux-ghostty-history-iterator.lib",
        "hmux-ghostty-vt-proof.receipt",
    ] {
        assert_eq!(
            fs::read(first.artifact_root.join(relative)).expect("read first Windows artifact"),
            fs::read(second.artifact_root.join(relative)).expect("read second Windows artifact"),
            "Windows artifact bytes changed at {relative}"
        );
    }
}

fn stage(input: &Path, target: &str, output: &Path) -> StagedSupply {
    let provenance = input.join("provenance");
    let mut arguments = vec![
        OsString::from("stage-ghostty-vt"),
        OsString::from("--ghostty-source"),
        provenance.join("ghostty-source.tar.gz").into_os_string(),
        OsString::from("--zig-archive"),
        provenance.join("zig.tar.xz").into_os_string(),
        OsString::from("--zig"),
        provenance.join("zig").into_os_string(),
        OsString::from("--uucode-cache"),
        provenance
            .join("uucode-0.2.0-ZZjBPlK5VADj7fdoq7G8LIHzD5o6FSkcBXXrRWr4jnrA.tar.gz")
            .into_os_string(),
        OsString::from("--highway-cache"),
        provenance
            .join("N-V-__8AAGmZhABbsPJLfbqrh6JTHsXhY6qCaLAQyx25e0XE.tar.gz")
            .into_os_string(),
        OsString::from("--target"),
        OsString::from(target),
        OsString::from("--output"),
        output.as_os_str().to_owned(),
    ];
    if target == "x86_64-pc-windows-msvc" {
        arguments.extend([
            OsString::from("--objcopy"),
            std::env::var_os("HMUX_GHOSTTY_SUPPLY_OBJCOPY")
                .expect("HMUX_GHOSTTY_SUPPLY_OBJCOPY must name reviewed rust-objcopy"),
        ]);
    }
    run_cli(arguments).unwrap_or_else(|error| panic!("stage {target}: {error}"))
}
