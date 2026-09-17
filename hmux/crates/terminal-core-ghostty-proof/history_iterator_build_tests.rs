use super::build_history_iterator;
use crate::ghostty_proof_receipt::StagedArtifacts;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

fn run(command: &mut Command) {
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "{command:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn fixture(root: &Path, outcome: &str) -> StagedArtifacts {
    let source = root.join("input/source/src");
    let toolchain = root.join("input/toolchain/zig-fixture");
    fs::create_dir_all(&source).unwrap();
    fs::create_dir_all(&toolchain).unwrap();
    fs::write(
        source.join("lib_vt.zig"),
        "const terminal = @import(\"terminal/main.zig\");\n",
    )
    .unwrap();
    fs::write(
        root.join("fixture.c"),
        "int proof_answer(void) { return 41; }\n",
    )
    .unwrap();
    run(Command::new("cc")
        .arg("-c")
        .arg(root.join("fixture.c"))
        .arg("-o")
        .arg(root.join("fixture.o")));
    run(Command::new("ar")
        .arg("rcs")
        .arg(toolchain.join("fixture.a"))
        .arg(root.join("fixture.o")));
    // The compiler is a tiny stand-in; archive extraction, the production build
    // function, native archive, final linker and consumer execution are real.
    let zig = toolchain.join("zig");
    fs::write(
        &zig,
        format!(
            r#"#!/bin/sh
set -eu
prefix=
while [ "$#" -gt 0 ]; do
  if [ "$1" = --prefix ]; then prefix=$2; shift; fi
  shift
done
[ -n "$prefix" ]
/bin/mkdir -p "$prefix/lib"
case {outcome} in
  success) /bin/cp "${{0%/*}}/fixture.a" "$prefix/lib/libhmux-ghostty-history-iterator.a" ;;
  failure) printf partial > "$prefix/lib/libhmux-ghostty-history-iterator.a"; exit 42 ;;
  missing) exit 0 ;;
  symlink) /bin/ln -s "${{0%/*}}/fixture.a" "$prefix/lib/libhmux-ghostty-history-iterator.a" ;;
esac
"#
        ),
    )
    .unwrap();
    fs::set_permissions(&zig, fs::Permissions::from_mode(0o700)).unwrap();
    let source_archive = root.join("source.tar.gz");
    run(Command::new("/usr/bin/tar")
        .arg("-czf")
        .arg(&source_archive)
        .arg("-C")
        .arg(root.join("input"))
        .arg("source"));
    let zig_archive = root.join("zig.tar.xz");
    run(Command::new("/usr/bin/tar")
        .arg("-cJf")
        .arg(&zig_archive)
        .arg("-C")
        .arg(root.join("input/toolchain"))
        .arg("zig-fixture"));
    let uucode_archive = root.join("uucode.tar.gz");
    fs::write(&uucode_archive, b"fixture package").unwrap();
    StagedArtifacts {
        include_dir: source,
        library: toolchain.join("fixture.a"),
        library_name: "fixture".into(),
        history_iterator_library: None,
        history_iterator_library_name: None,
        source_archive,
        zig_archive,
        uucode_archive,
        highway_archive: None,
        watched_paths: Vec::new(),
    }
}

fn entries(root: &Path) -> Vec<PathBuf> {
    let mut result = Vec::new();
    for entry in fs::read_dir(root).unwrap() {
        let entry = entry.unwrap();
        if entry.file_type().unwrap().is_dir() {
            result.extend(entries(&entry.path()));
        }
        result.push(entry.path());
    }
    result.sort();
    result
}

fn target() -> &'static str {
    if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            "aarch64-apple-darwin"
        } else {
            "x86_64-apple-darwin"
        }
    } else if cfg!(target_arch = "aarch64") {
        "aarch64-unknown-linux-musl"
    } else {
        "x86_64-unknown-linux-musl"
    }
}

#[test]
fn successful_build_retires_preparation_and_keeps_a_linkable_library() {
    let root = tempfile::tempdir().unwrap();
    let artifacts = fixture(root.path(), "success");
    let out = root.path().join("out");
    fs::create_dir(&out).unwrap();
    let other_output = out.join("unrelated-output");
    fs::write(&other_output, b"keep").unwrap();
    for _ in 0..2 {
        let library = build_history_iterator(&artifacts, target(), &out);
        let mut expected = vec![library.clone(), other_output.clone()];
        expected.sort();
        assert_eq!(
            entries(&out),
            expected,
            "build preparation must not accumulate"
        );
        assert_eq!(fs::read(&other_output).unwrap(), b"keep");
        let consumer = root.path().join("consumer.c");
        let executable = root.path().join("consumer");
        fs::write(
            &consumer,
            "int proof_answer(void); int main(void) { return proof_answer() == 41 ? 0 : 1; }\n",
        )
        .unwrap();
        run(Command::new("cc")
            .arg(&consumer)
            .arg(&library)
            .arg("-o")
            .arg(&executable));
        run(&mut Command::new(&executable));
    }
}

#[test]
fn failed_compiler_or_missing_library_retires_scratch_without_replacing_outputs() {
    for outcome in ["failure", "missing", "symlink"] {
        let root = tempfile::tempdir().unwrap();
        let good = fixture(&root.path().join("good"), "success");
        let bad = fixture(&root.path().join("bad"), outcome);
        let out = root.path().join("out");
        fs::create_dir(&out).unwrap();
        let library = build_history_iterator(&good, target(), &out);
        let before = fs::read(&library).unwrap();
        let failed = std::panic::catch_unwind(|| build_history_iterator(&bad, target(), &out));
        assert!(failed.is_err(), "{outcome} must fail the build");
        assert_eq!(
            fs::read(&library).unwrap(),
            before,
            "retain previous archive"
        );
        assert_eq!(
            entries(&out),
            vec![library],
            "failed preparation must retire"
        );
    }
}
