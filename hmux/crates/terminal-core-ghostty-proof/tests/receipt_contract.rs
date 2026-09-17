#[path = "../ghostty_proof_receipt.rs"]
mod ghostty_proof_receipt;

#[cfg(unix)]
#[path = "../history_iterator_build.rs"]
mod history_iterator_build;

use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;

fn consume_validated_artifacts(artifacts: ghostty_proof_receipt::ValidatedArtifacts) {
    let _ = (
        artifacts.header_root,
        artifacts.header_sha256,
        artifacts.library,
        artifacts.library_sha256,
        artifacts.history_iterator_library,
        artifacts.history_iterator_library_sha256,
        artifacts.source_archive,
        artifacts.source_archive_sha256,
        artifacts.zig_archive,
        artifacts.zig_archive_sha256,
        artifacts.uucode_archive,
        artifacts.uucode_archive_sha256,
        artifacts.highway_archive,
        artifacts.highway_archive_sha256,
        artifacts.watched_paths,
    );
}

fn synthetic_artifacts(root: &Path) -> ghostty_proof_receipt::ValidatedArtifacts {
    let header_root = root.join("source/include/ghostty");
    fs::create_dir_all(header_root.join("detail")).unwrap();
    fs::write(
        header_root.join("vt.h"),
        b"#include <ghostty/detail/core.h>\n",
    )
    .unwrap();
    fs::write(
        header_root.join("detail/core.h"),
        b"typedef int GhosttyCore;\n",
    )
    .unwrap();
    let library = root.join("source/libghostty-vt.a");
    fs::write(&library, b"synthetic archive").unwrap();
    let source_archive = root.join("source/ghostty-source.tar.gz");
    let zig_archive = root.join("source/zig.tar.xz");
    let uucode_archive = root.join("source/uucode.tar.gz");
    fs::write(&source_archive, b"synthetic source archive").unwrap();
    fs::write(&zig_archive, b"synthetic Zig archive").unwrap();
    fs::write(&uucode_archive, b"synthetic uucode archive").unwrap();
    let header_sha256 = ghostty_proof_receipt::sha256_header_tree(&header_root)
        .unwrap()
        .0;
    let library_sha256 = format!("{:x}", Sha256::digest(fs::read(&library).unwrap()));
    ghostty_proof_receipt::ValidatedArtifacts {
        header_root,
        header_sha256,
        library,
        library_sha256,
        history_iterator_library: None,
        history_iterator_library_sha256: None,
        source_archive,
        source_archive_sha256: format!("{:x}", Sha256::digest(b"synthetic source archive")),
        zig_archive,
        zig_archive_sha256: format!("{:x}", Sha256::digest(b"synthetic Zig archive")),
        uucode_archive,
        uucode_archive_sha256: format!("{:x}", Sha256::digest(b"synthetic uucode archive")),
        highway_archive: None,
        highway_archive_sha256: None,
        watched_paths: Vec::new(),
    }
}

#[test]
fn exact_receipt_mismatch_fails_before_any_artifact_or_link_lookup() {
    let root = tempfile::tempdir().unwrap();
    fs::write(
        root.path().join("hmux-ghostty-vt-proof.receipt"),
        "schema=hmux-ghostty-vt-proof-v1\ntarget=aarch64-apple-darwin\n",
    )
    .unwrap();

    let error = ghostty_proof_receipt::validate(root.path(), "aarch64-apple-darwin")
        .err()
        .expect("a non-reviewed receipt must fail closed");
    assert!(error.contains("does not match exact reviewed receipt"));
    assert!(
        !error.contains("library") && !error.contains("header"),
        "receipt identity must fail before any native artifact is inspected: {error}"
    );
}

#[test]
fn packaged_v2_receipt_is_parsed_before_artifact_lookup() {
    let root = tempfile::tempdir().unwrap();
    fs::write(
        root.path().join("hmux-ghostty-vt-proof.receipt"),
        concat!(
            "schema=hmux-ghostty-vt-artifact-v2\n",
            "target=x86_64-apple-darwin\n",
            "recipe_id=missing-fields-must-fail-after-schema-admission\n",
        ),
    )
    .unwrap();

    let error = ghostty_proof_receipt::validate(root.path(), "x86_64-apple-darwin")
        .err()
        .expect("an incomplete packaged receipt must fail closed");
    assert!(
        error.contains("receipt field ghostty_commit is missing"),
        "v2 must reach the closed recipe schema before any artifact lookup: {error}"
    );
    assert!(!error.contains("library") && !error.contains("header"));
}

#[test]
fn packaged_adoption_target_matrix_is_explicit_and_host_only() {
    let _ = consume_validated_artifacts as fn(ghostty_proof_receipt::ValidatedArtifacts);
    let _ = ghostty_proof_receipt::validate_and_stage
        as fn(&Path, &str, &Path) -> Result<ghostty_proof_receipt::StagedArtifacts, String>;
    assert_eq!(
        ghostty_proof_receipt::PACKAGED_HOST_TARGETS,
        [
            "aarch64-apple-darwin",
            "x86_64-apple-darwin",
            "aarch64-unknown-linux-musl",
            "x86_64-unknown-linux-musl",
            "x86_64-pc-windows-msvc",
        ]
    );
    assert!(
        ghostty_proof_receipt::PACKAGED_HOST_TARGETS
            .iter()
            .all(|target| !target.contains("ios") && !target.contains("android"))
    );
}

#[test]
fn staged_closure_rehash_rejects_source_mutation_after_validation() {
    let root = tempfile::tempdir().unwrap();
    let artifacts = synthetic_artifacts(root.path());
    fs::write(
        artifacts.header_root.join("detail/core.h"),
        b"mutated after validation\n",
    )
    .unwrap();

    let error = ghostty_proof_receipt::stage(artifacts, &root.path().join("out"))
        .err()
        .expect("source mutation must fail before compilation");
    assert!(error.contains("staged C header closure SHA-256"));
}

#[test]
fn staged_archive_rehash_rejects_source_mutation_after_validation() {
    let root = tempfile::tempdir().unwrap();
    let artifacts = synthetic_artifacts(root.path());
    fs::write(&artifacts.library, b"mutated archive after validation").unwrap();

    let error = ghostty_proof_receipt::stage(artifacts, &root.path().join("out"))
        .err()
        .expect("archive mutation must fail before linking");
    assert!(error.contains("staged Ghostty archive SHA-256"));
}

#[test]
fn staged_provenance_rehash_rejects_mutation_after_validation() {
    let root = tempfile::tempdir().unwrap();
    let artifacts = synthetic_artifacts(root.path());
    fs::write(&artifacts.source_archive, b"mutated source archive").unwrap();

    let error = ghostty_proof_receipt::stage(artifacts, &root.path().join("out"))
        .err()
        .expect("provenance mutation must fail before the Zig build");
    assert!(error.contains("staged Ghostty source archive SHA-256"));
}

#[test]
fn staged_artifacts_are_content_addressed_and_build_owned() {
    let root = tempfile::tempdir().unwrap();
    let out_dir = root.path().join("out");
    let staged = ghostty_proof_receipt::stage(synthetic_artifacts(root.path()), &out_dir).unwrap();

    assert!(staged.include_dir.starts_with(&out_dir));
    assert!(staged.library.starts_with(&out_dir));
    assert!(staged.history_iterator_library.is_none());
    assert!(staged.history_iterator_library_name.is_none());
    assert!(staged.source_archive.starts_with(&out_dir));
    assert!(staged.zig_archive.starts_with(&out_dir));
    assert!(staged.uucode_archive.starts_with(&out_dir));
    assert_eq!(staged.highway_archive, None);
    assert!(staged.watched_paths.is_empty());
    assert!(
        staged
            .library
            .file_name()
            .unwrap()
            .to_string_lossy()
            .contains(&staged.library_name)
    );
    assert_eq!(
        fs::read(staged.include_dir.join("ghostty/detail/core.h")).unwrap(),
        b"typedef int GhosttyCore;\n"
    );
    assert_eq!(
        fs::read(staged.source_archive).unwrap(),
        b"synthetic source archive"
    );
    assert_eq!(
        fs::read(staged.zig_archive).unwrap(),
        b"synthetic Zig archive"
    );
    assert_eq!(
        fs::read(staged.uucode_archive).unwrap(),
        b"synthetic uucode archive"
    );
}

#[cfg(unix)]
#[test]
fn staged_alias_replacement_fails_closed_on_reuse() {
    use std::os::unix::fs::symlink;

    let root = tempfile::tempdir().unwrap();
    let out_dir = root.path().join("out");
    let first = ghostty_proof_receipt::stage(synthetic_artifacts(root.path()), &out_dir).unwrap();
    fs::remove_file(&first.library).unwrap();
    symlink(root.path().join("source/libghostty-vt.a"), &first.library).unwrap();

    let error = ghostty_proof_receipt::stage(synthetic_artifacts(root.path()), &out_dir)
        .err()
        .expect("a staged symlink alias must not reach the linker");
    assert!(error.contains("artifact is not one regular file"));
}
