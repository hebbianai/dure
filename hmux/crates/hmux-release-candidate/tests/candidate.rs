use flate2::Compression;
use flate2::write::{GzEncoder, ZlibEncoder};
use hmux_release_candidate::{
    CandidateOptions, VerifyCandidateOptions, create_release_candidate, verify_release_candidate,
};
use hmux_release_trust::ReleaseChannel;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fmt::Write as _;
use std::fs::{self, File};
use std::io::{self, Write};
#[cfg(unix)]
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::process::Command;
use tar::{Builder, EntryType, Header};
use tempfile::TempDir;

const SOURCE_COMMIT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TARGETS: [&str; 2] = ["aarch64-unknown-linux-musl", "x86_64-unknown-linux-musl"];
const FAKE_ELF_DYNAMIC_OFFSET: usize = 560;

struct Fixture {
    _temporary: TempDir,
    root: PathBuf,
    output: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let root = temporary.path().join("artifacts");
        fs::create_dir(&root).expect("artifact root");
        for target in TARGETS {
            write_tree(&root, target, 1, "1.0", "1.0", "0.1.4");
            write_archive(&root, target, 0o755, None);
        }
        write_checksums(&root);
        let output = root.join("release-candidate.json");
        Self {
            _temporary: temporary,
            root,
            output,
        }
    }

    fn options(&self) -> CandidateOptions {
        CandidateOptions {
            channel: ReleaseChannel::Stable,
            source_commit: SOURCE_COMMIT.to_owned(),
            workflow_run_id: 1,
            workflow_run_attempt: 1,
            artifact_root: self.root.clone(),
            output: self.output.clone(),
        }
    }

    fn manifest(&self, target: &str) -> Value {
        serde_json::from_slice(
            &fs::read(self.root.join(target).join("install.json")).expect("manifest"),
        )
        .expect("manifest JSON")
    }
}

#[test]
fn creates_closed_candidate_with_shared_signed_schema_and_shell_digest() {
    let fixture = Fixture::new();
    let candidate = create_release_candidate(fixture.options()).expect("valid candidate");
    let value = serde_json::to_value(&candidate).expect("candidate JSON");
    assert_eq!(value["sourceCommit"], SOURCE_COMMIT);
    assert_eq!(value["channel"], "stable");
    assert_eq!(
        value["publicationOrder"][1],
        Value::String("hash_prefixed_target".to_owned())
    );
    let artifacts = value["artifacts"].as_array().expect("artifacts");
    assert_eq!(artifacts.len(), 2);
    for artifact in artifacts {
        let custom: hmux_release_trust::SignedTargetMetadata =
            serde_json::from_value(artifact["custom"].clone()).expect("shared signed schema");
        assert_eq!(
            artifact["logicalTargetPath"],
            format!("{}.tar.gz", custom.build_id)
        );
        assert_eq!(custom.source_commit, SOURCE_COMMIT);
        assert_eq!(custom.channel, ReleaseChannel::Stable);
        assert_eq!(custom.archive_format, "tar.gz");
        assert_eq!(custom.product, "hmux");
        assert_eq!(
            custom.installed_tree_sha256,
            shell_tree_digest(&fixture.root.join(custom.target_triple.to_string()))
        );
    }
    assert!(fixture.output.is_file());
    for target in TARGETS {
        fs::remove_dir_all(fixture.root.join(target)).expect("remove builder-only tree");
    }
    let verified = verify_release_candidate(VerifyCandidateOptions {
        channel: ReleaseChannel::Stable,
        source_commit: SOURCE_COMMIT.to_owned(),
        workflow_run_id: 1,
        workflow_run_attempt: 1,
        artifact_root: fixture.root.clone(),
        candidate: fixture.output.clone(),
    })
    .expect("protected bundle revalidation");
    assert_eq!(
        serde_json::to_value(verified).expect("verified JSON"),
        value
    );
}

#[test]
fn refuses_source_commit_build_id_and_cross_target_invocation_mismatches() {
    let fixture = Fixture::new();
    let mut options = fixture.options();
    options.source_commit = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_owned();
    let error = create_release_candidate(options).expect_err("commit mismatch");
    assert!(error.to_string().contains("build_identity_invalid"));
    assert!(!fixture.output.exists());

    let fixture = Fixture::new();
    let target = TARGETS[0];
    let old_archive = archive_path(&fixture.root, target);
    fs::remove_file(old_archive).expect("remove old archive");
    let mut manifest = fixture.manifest(target);
    manifest["buildId"] = Value::String(build_id(target, 2));
    write_manifest(&fixture.root, target, &manifest);
    write_archive(&fixture.root, target, 0o755, None);
    write_checksums(&fixture.root);
    let error = create_release_candidate(fixture.options()).expect_err("invocation mismatch");
    assert!(error.to_string().contains("build_identity_invalid"));
}

#[test]
fn refuses_open_asset_or_checksum_inventories() {
    let fixture = Fixture::new();
    fs::write(fixture.root.join("surprise.tar.gz"), b"unsigned").expect("extra archive");
    let error = create_release_candidate(fixture.options()).expect_err("extra archive");
    assert!(error.to_string().contains("inventory_invalid"));
    assert!(!fixture.output.exists());

    let fixture = Fixture::new();
    let checksum_path = fixture.root.join("SHA256SUMS");
    let first = fs::read_to_string(&checksum_path)
        .expect("checksums")
        .lines()
        .next()
        .expect("first checksum")
        .to_owned();
    fs::write(&checksum_path, format!("{first}\n{first}\n")).expect("duplicate checksum");
    let error = create_release_candidate(fixture.options()).expect_err("duplicate checksum");
    assert!(error.to_string().contains("checksums_invalid"));
}

#[test]
fn refuses_archive_corruption_extra_members_and_non_executable_modes() {
    let fixture = Fixture::new();
    let target = TARGETS[0];
    write_archive(
        &fixture.root,
        target,
        0o755,
        Some(("unexpected", EntryType::Regular)),
    );
    write_checksums(&fixture.root);
    let error = create_release_candidate(fixture.options()).expect_err("extra member");
    assert!(error.to_string().contains("archive_invalid"));

    let fixture = Fixture::new();
    let target = TARGETS[0];
    write_archive(&fixture.root, target, 0o644, None);
    write_checksums(&fixture.root);
    let error = create_release_candidate(fixture.options()).expect_err("wrong mode");
    assert!(error.to_string().contains("archive_invalid"));

    let fixture = Fixture::new();
    let target = TARGETS[0];
    let archive = archive_path(&fixture.root, target);
    let length = fs::metadata(&archive).expect("archive metadata").len();
    File::options()
        .write(true)
        .open(&archive)
        .expect("archive")
        .set_len(length / 2)
        .expect("truncate archive");
    write_checksums(&fixture.root);
    let error = create_release_candidate(fixture.options()).expect_err("truncated gzip");
    assert!(error.to_string().contains("archive_invalid"));
}

#[test]
fn refuses_ambiguous_or_corrupt_gzip_framing() {
    let fixture = Fixture::new();
    let archive = archive_path(&fixture.root, TARGETS[0]);
    File::options()
        .append(true)
        .open(&archive)
        .expect("archive")
        .write_all(b"trailing")
        .expect("append trailing bytes");
    write_checksums(&fixture.root);
    let error = create_release_candidate(fixture.options()).expect_err("trailing bytes");
    assert!(error.to_string().contains("archive_invalid"));

    let fixture = Fixture::new();
    let archive = archive_path(&fixture.root, TARGETS[0]);
    let mut second = GzEncoder::new(Vec::new(), Compression::default());
    second.write_all(&[0_u8; 1024]).expect("second gzip");
    let second = second.finish().expect("finish second gzip");
    File::options()
        .append(true)
        .open(&archive)
        .expect("archive")
        .write_all(&second)
        .expect("append second gzip");
    write_checksums(&fixture.root);
    let error = create_release_candidate(fixture.options()).expect_err("multiple gzip members");
    assert!(error.to_string().contains("archive_invalid"));

    let fixture = Fixture::new();
    let archive = archive_path(&fixture.root, TARGETS[0]);
    let mut bytes = fs::read(&archive).expect("archive");
    let last = bytes.last_mut().expect("gzip footer");
    *last ^= 0xff;
    fs::write(&archive, bytes).expect("corrupt gzip footer");
    write_checksums(&fixture.root);
    let error = create_release_candidate(fixture.options()).expect_err("bad gzip footer");
    assert!(error.to_string().contains("archive_invalid"));

    let fixture = Fixture::new();
    let archive = archive_path(&fixture.root, TARGETS[0]);
    let length = fs::metadata(&archive).expect("archive").len();
    File::options()
        .write(true)
        .open(&archive)
        .expect("archive")
        .set_len(length - 4)
        .expect("late truncate");
    write_checksums(&fixture.root);
    let error = create_release_candidate(fixture.options()).expect_err("late truncation");
    assert!(error.to_string().contains("archive_invalid"));
}

#[test]
fn refuses_links_in_source_and_archive() {
    let fixture = Fixture::new();
    let target = TARGETS[0];
    write_archive(
        &fixture.root,
        target,
        0o755,
        Some((&format!("{target}/bin/hmux-runtime"), EntryType::Link)),
    );
    write_checksums(&fixture.root);
    let error = create_release_candidate(fixture.options()).expect_err("archive hard link");
    assert!(error.to_string().contains("archive_invalid"));

    let fixture = Fixture::new();
    let target = TARGETS[0];
    write_archive(
        &fixture.root,
        target,
        0o755,
        Some((&format!("{target}/bin/hmux-runtime"), EntryType::Symlink)),
    );
    write_checksums(&fixture.root);
    let error = create_release_candidate(fixture.options()).expect_err("archive symbolic link");
    assert!(error.to_string().contains("archive_invalid"));

    #[cfg(unix)]
    {
        let fixture = Fixture::new();
        let binary = fixture.root.join(TARGETS[0]).join("bin/hmux");
        let replacement = fixture
            .root
            .parent()
            .expect("temporary root")
            .join("hmux-real");
        fs::rename(&binary, &replacement).expect("move binary");
        symlink(&replacement, &binary).expect("symlink binary");
        let error = create_release_candidate(fixture.options()).expect_err("source symlink");
        assert!(error.to_string().contains("file_unsafe"));
    }
}

#[test]
fn enforces_shared_build_id_limit_and_binary_provenance() {
    let fixture = Fixture::new();
    let longest_target = TARGETS
        .into_iter()
        .max_by_key(|target| build_id_for_version(target, "0.1.4+").len())
        .expect("target");
    let fixed = build_id_for_version(longest_target, "0.1.4+").len();
    let accepted_version = format!("0.1.4+{}", "a".repeat(128 - fixed));
    rebuild_all(&fixture.root, &accepted_version);
    assert_eq!(
        TARGETS
            .into_iter()
            .map(|target| build_id_for_version(target, &accepted_version).len())
            .max(),
        Some(128)
    );
    create_release_candidate(fixture.options()).expect("128-byte build id");

    let fixture = Fixture::new();
    let refused_version = format!("0.1.4+{}", "a".repeat(129 - fixed));
    rebuild_all(&fixture.root, &refused_version);
    let error = create_release_candidate(fixture.options()).expect_err("129-byte build id");
    assert!(error.to_string().contains("build_identity_invalid"));

    let fixture = Fixture::new();
    let binary = fixture.root.join(TARGETS[0]).join("bin/hmux");
    let mut bytes = fs::read(&binary).expect("ELF");
    bytes[18..20].copy_from_slice(&62_u16.to_le_bytes());
    fs::write(&binary, bytes).expect("wrong machine");
    set_mode(&binary, 0o755);
    let error = create_release_candidate(fixture.options()).expect_err("wrong ELF machine");
    assert!(error.to_string().contains("file_unsafe"));
}

#[test]
fn refuses_non_runnable_or_dynamically_linked_elf_claims() {
    assert_binary_mutation_is_refused("invalid Linux ABI", |bytes| bytes[7] = 9);
    assert_binary_mutation_is_refused("invalid entry point", |bytes| {
        write_u64(bytes, 24, 0);
    });
    assert_binary_mutation_is_refused("unaligned AArch64 entry point", |bytes| {
        write_u64(bytes, 24, 0x10c1);
    });
    assert_binary_mutation_is_refused("non-executable load", |bytes| {
        write_u32(bytes, 68, 4);
    });
    assert_binary_mutation_is_refused("load memory smaller than file", |bytes| {
        write_u64(bytes, 104, 1);
    });
    assert_binary_mutation_is_refused("misaligned load", |bytes| {
        write_u64(bytes, 80, 0x1001);
    });
    assert_binary_mutation_is_refused("dynamic dependency", |bytes| {
        write_u64(bytes, FAKE_ELF_DYNAMIC_OFFSET, 1);
    });
}

#[test]
fn requires_decodable_matching_cargo_audit_data_in_every_binary() {
    assert_binary_mutation_is_refused("missing cargo audit data", |bytes| {
        write_u16(bytes, 60, 3);
    });
    assert_binary_mutation_is_refused("corrupt cargo audit data", |bytes| {
        let section_offset = read_u64_at(bytes, 40) as usize;
        let audit_header = section_offset + 3 * 64;
        let audit_offset = read_u64_at(bytes, audit_header + 24) as usize;
        bytes[audit_offset] ^= 0xff;
    });

    let fixture = Fixture::new();
    let target = TARGETS[0];
    let binary = fixture.root.join(target).join("bin/hmux");
    let build_id = build_id_for_version(target, "0.1.4");
    fs::write(
        &binary,
        fake_elf_with_audit_root(target, "hmux", &build_id, "0.1.4", SOURCE_COMMIT, "otherxx"),
    )
    .expect("mismatched cargo audit root");
    set_mode(&binary, 0o755);
    let error = create_release_candidate(fixture.options()).expect_err("audit root mismatch");
    assert!(
        error
            .to_string()
            .contains("cargo audit root package mismatch")
    );
}

#[test]
fn enforces_bounds_before_manifest_allocation() {
    let fixture = Fixture::new();
    let manifest = fixture.root.join(TARGETS[0]).join("install.json");
    File::options()
        .write(true)
        .open(&manifest)
        .expect("manifest")
        .set_len(64 * 1024 + 1)
        .expect("sparse oversized manifest");
    let error = create_release_candidate(fixture.options()).expect_err("oversized manifest");
    assert!(error.to_string().contains("file_too_large"));
}

#[test]
fn shares_strict_semver_and_protocol_validation_with_verifier() {
    let fixture = Fixture::new();
    let target = TARGETS[0];
    let mut manifest = fixture.manifest(target);
    manifest["protocol"]["minimum"] = Value::String("18446744073709551616.0".to_owned());
    write_manifest(&fixture.root, target, &manifest);
    let error = create_release_candidate(fixture.options()).expect_err("overflow protocol");
    assert!(error.to_string().contains("protocol_invalid"));

    let fixture = Fixture::new();
    let target = TARGETS[0];
    let old_archive = archive_path(&fixture.root, target);
    fs::remove_file(old_archive).expect("old archive");
    write_tree(&fixture.root, target, 1, "2.0", "1.0", "not-semver");
    write_archive(&fixture.root, target, 0o755, None);
    write_checksums(&fixture.root);
    let error = create_release_candidate(fixture.options()).expect_err("invalid semver");
    assert!(error.to_string().contains("manifest_invalid"));
}

#[test]
fn refuses_archive_that_does_not_reproduce_staged_tree() {
    let fixture = Fixture::new();
    let binary = fixture.root.join(TARGETS[0]).join("bin/hmux");
    File::options()
        .append(true)
        .open(&binary)
        .expect("binary")
        .write_all(b"changed after archive")
        .expect("mutate tree");
    set_mode(&binary, 0o755);
    let error = create_release_candidate(fixture.options()).expect_err("tree mismatch");
    assert!(error.to_string().contains("archive_tree_mismatch"));
}

#[test]
fn protected_bundle_verification_rejects_candidate_hints() {
    let fixture = Fixture::new();
    create_release_candidate(fixture.options()).expect("candidate");
    for target in TARGETS {
        fs::remove_dir_all(fixture.root.join(target)).expect("remove builder tree");
    }
    let mut candidate: Value =
        serde_json::from_slice(&fs::read(&fixture.output).expect("candidate")).expect("JSON");
    candidate["artifacts"][0]["custom"]["product"] = Value::String("other".to_owned());
    fs::write(
        &fixture.output,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&candidate).expect("candidate JSON")
        ),
    )
    .expect("tampered candidate");
    set_mode(&fixture.output, 0o644);
    let error = verify_release_candidate(VerifyCandidateOptions {
        channel: ReleaseChannel::Stable,
        source_commit: SOURCE_COMMIT.to_owned(),
        workflow_run_id: 1,
        workflow_run_attempt: 1,
        artifact_root: fixture.root.clone(),
        candidate: fixture.output.clone(),
    })
    .expect_err("tampered hint");
    assert!(error.to_string().contains("manifest_invalid"));
}

fn assert_binary_mutation_is_refused(reason: &str, mutate: impl FnOnce(&mut [u8])) {
    let fixture = Fixture::new();
    let binary = fixture.root.join(TARGETS[0]).join("bin/hmux");
    let mut bytes = fs::read(&binary).expect("ELF");
    mutate(&mut bytes);
    fs::write(&binary, bytes).expect("mutated ELF");
    set_mode(&binary, 0o755);
    let error = create_release_candidate(fixture.options()).expect_err(reason);
    assert!(
        error.to_string().contains("file_unsafe"),
        "{reason}: {error}"
    );
}

fn write_tree(
    root: &Path,
    target: &str,
    run_id: u64,
    minimum: &str,
    maximum: &str,
    package_version: &str,
) {
    let tree = root.join(target);
    fs::create_dir_all(tree.join("bin")).expect("tree");
    set_mode(&tree, 0o755);
    set_mode(&tree.join("bin"), 0o755);
    let build_id = format!(
        "{package_version}+{}.run-{run_id}-1.{target}.release",
        &SOURCE_COMMIT[..12]
    );
    for name in ["hmux", "hmux-runtime"] {
        let path = tree.join("bin").join(name);
        fs::write(
            &path,
            fake_elf(target, name, &build_id, package_version, SOURCE_COMMIT),
        )
        .expect("binary");
        set_mode(&path, 0o755);
    }
    let manifest = json!({
        "schemaVersion": 1,
        "buildId": build_id,
        "packageVersion": package_version,
        "profile": "release",
        "targetTriple": target,
        "protocol": {"minimum": minimum, "maximum": maximum},
    });
    write_manifest(root, target, &manifest);
}

fn write_manifest(root: &Path, target: &str, manifest: &Value) {
    let path = root.join(target).join("install.json");
    let encoded = |field: &Value| serde_json::to_string(field).expect("manifest field");
    fs::write(
        &path,
        format!(
            concat!(
                "{{\n",
                "  \"schemaVersion\": {},\n",
                "  \"buildId\": {},\n",
                "  \"packageVersion\": {},\n",
                "  \"profile\": {},\n",
                "  \"targetTriple\": {},\n",
                "  \"protocol\": {{ \"minimum\": {}, \"maximum\": {} }}\n",
                "}}\n"
            ),
            encoded(&manifest["schemaVersion"]),
            encoded(&manifest["buildId"]),
            encoded(&manifest["packageVersion"]),
            encoded(&manifest["profile"]),
            encoded(&manifest["targetTriple"]),
            encoded(&manifest["protocol"]["minimum"]),
            encoded(&manifest["protocol"]["maximum"]),
        ),
    )
    .expect("manifest");
    set_mode(&path, 0o644);
}

fn build_id(target: &str, run_id: u64) -> String {
    build_id_for_version_and_run(target, "0.1.4", run_id)
}

fn build_id_for_version(target: &str, package_version: &str) -> String {
    build_id_for_version_and_run(target, package_version, 1)
}

fn build_id_for_version_and_run(target: &str, package_version: &str, run_id: u64) -> String {
    format!(
        "{package_version}+{}.run-{run_id}-1.{target}.release",
        &SOURCE_COMMIT[..12]
    )
}

fn rebuild_all(root: &Path, package_version: &str) {
    for target in TARGETS {
        let old_archive = archive_path(root, target);
        fs::remove_file(old_archive).expect("old archive");
        write_tree(root, target, 1, "1.0", "1.0", package_version);
        write_archive(root, target, 0o755, None);
    }
    write_checksums(root);
}

fn archive_path(root: &Path, target: &str) -> PathBuf {
    let manifest: Value = serde_json::from_slice(
        &fs::read(root.join(target).join("install.json")).expect("manifest"),
    )
    .expect("manifest JSON");
    root.join(format!(
        "{}.tar.gz",
        manifest["buildId"].as_str().expect("build id")
    ))
}

fn write_archive(
    root: &Path,
    target: &str,
    executable_mode: u32,
    extra: Option<(&str, EntryType)>,
) {
    let archive = archive_path(root, target);
    let file = File::create(archive).expect("archive");
    let encoder = GzEncoder::new(file, Compression::default());
    let mut builder = Builder::new(encoder);
    append_member(
        &mut builder,
        &format!("{target}/"),
        EntryType::Directory,
        0o755,
        &[],
        None,
    );
    append_member(
        &mut builder,
        &format!("{target}/bin/"),
        EntryType::Directory,
        0o755,
        &[],
        None,
    );
    for name in ["hmux", "hmux-runtime"] {
        let member_path = format!("{target}/bin/{name}");
        if extra.is_some_and(|(path, _)| path == member_path) {
            continue;
        }
        let bytes = fs::read(root.join(target).join("bin").join(name)).expect("binary");
        append_member(
            &mut builder,
            &member_path,
            EntryType::Regular,
            executable_mode,
            &bytes,
            None,
        );
    }
    let manifest = fs::read(root.join(target).join("install.json")).expect("manifest");
    append_member(
        &mut builder,
        &format!("{target}/install.json"),
        EntryType::Regular,
        0o644,
        &manifest,
        None,
    );
    if let Some((name, entry_type)) = extra {
        let link = (entry_type == EntryType::Link).then_some(format!("{target}/bin/hmux"));
        append_member(
            &mut builder,
            name,
            entry_type,
            0o755,
            if link.is_some() { &[] } else { b"extra" },
            link.as_deref(),
        );
    }
    let encoder = builder.into_inner().expect("finish tar");
    encoder.finish().expect("finish gzip");
}

fn append_member<W: Write>(
    builder: &mut Builder<W>,
    path: &str,
    entry_type: EntryType,
    mode: u32,
    contents: &[u8],
    link_name: Option<&str>,
) {
    let mut header = Header::new_gnu();
    header.set_path(path).expect("tar path");
    header.set_entry_type(entry_type);
    header.set_mode(mode);
    header.set_uid(0);
    header.set_gid(0);
    header.set_mtime(0);
    header.set_size(contents.len() as u64);
    if let Some(link_name) = link_name {
        header.set_link_name(link_name).expect("link name");
    }
    header.set_cksum();
    builder
        .append(&header, contents)
        .expect("append tar member");
}

fn write_checksums(root: &Path) {
    let mut entries = fs::read_dir(root)
        .expect("artifact root")
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            name.ends_with(".tar.gz").then_some((name, entry.path()))
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    let contents = entries
        .into_iter()
        .fold(String::new(), |mut output, (name, path)| {
            writeln!(&mut output, "{}  {name}", sha256_file(&path))
                .expect("writing to String cannot fail");
            output
        });
    let path = root.join("SHA256SUMS");
    fs::write(&path, contents).expect("checksums");
    set_mode(&path, 0o644);
}

fn sha256_file(path: &Path) -> String {
    let mut file = File::open(path).expect("hash file");
    let mut digest = Sha256::new();
    io::copy(&mut file, &mut DigestWriter(&mut digest)).expect("hash bytes");
    hex::encode(digest.finalize())
}

fn fake_elf(
    target: &str,
    binary: &str,
    build_id: &str,
    package_version: &str,
    source_commit: &str,
) -> Vec<u8> {
    let audit_root = if binary == "hmux" {
        "hmux-cli"
    } else {
        "hmux-runtime"
    };
    fake_elf_with_audit_root(
        target,
        binary,
        build_id,
        package_version,
        source_commit,
        audit_root,
    )
}

fn fake_elf_with_audit_root(
    target: &str,
    binary: &str,
    build_id: &str,
    package_version: &str,
    source_commit: &str,
    audit_root: &str,
) -> Vec<u8> {
    let provenance = serde_json::to_vec(&json!({
        "schemaVersion": 1,
        "product": "hmux",
        "binary": binary,
        "buildId": build_id,
        "sourceCommit": source_commit,
        "targetTriple": target,
    }))
    .expect("provenance JSON");
    let audit_json = serde_json::to_vec(&json!({
        "format": 1,
        "packages": [{
            "name": audit_root,
            "version": package_version,
            "source": "local",
            "root": true,
        }],
    }))
    .expect("cargo audit JSON");
    let mut audit_encoder = ZlibEncoder::new(Vec::new(), Compression::best());
    audit_encoder
        .write_all(&audit_json)
        .expect("compress cargo audit JSON");
    let audit_data = audit_encoder.finish().expect("finish cargo audit JSON");
    let names = b"\0.shstrtab\0.hmux.build\0.dep-v0\0";
    let names_offset = 512_u64;
    let dynamic_offset = FAKE_ELF_DYNAMIC_OFFSET as u64;
    let provenance_offset = 576_u64;
    let audit_offset = provenance_offset + provenance.len() as u64;
    let length = usize::try_from(audit_offset).expect("offset") + audit_data.len();
    let virtual_address = 0x1000_u64;
    let code_offset = 192_u64;
    let mut elf = vec![0_u8; length];
    elf[0..4].copy_from_slice(b"\x7fELF");
    elf[4] = 2;
    elf[5] = 1;
    elf[6] = 1;
    write_u16(&mut elf, 16, 2);
    write_u16(
        &mut elf,
        18,
        if target.starts_with("x86_64") {
            62
        } else {
            183
        },
    );
    write_u32(&mut elf, 20, 1);
    write_u64(&mut elf, 24, virtual_address + code_offset);
    write_u64(&mut elf, 32, 64);
    write_u64(&mut elf, 40, 256);
    write_u16(&mut elf, 52, 64);
    write_u16(&mut elf, 54, 56);
    write_u16(&mut elf, 56, 2);
    write_u16(&mut elf, 58, 64);
    write_u16(&mut elf, 60, 4);
    write_u16(&mut elf, 62, 1);

    write_u32(&mut elf, 64, 1);
    write_u32(&mut elf, 68, 5);
    write_u64(&mut elf, 80, virtual_address);
    write_u64(&mut elf, 96, length as u64);
    write_u64(&mut elf, 104, length as u64);
    write_u64(&mut elf, 112, 4096);

    write_u32(&mut elf, 120, 2);
    write_u32(&mut elf, 124, 4);
    write_u64(&mut elf, 128, dynamic_offset);
    write_u64(&mut elf, 136, virtual_address + dynamic_offset);
    write_u64(&mut elf, 152, 16);
    write_u64(&mut elf, 160, 16);
    write_u64(&mut elf, 168, 8);

    if target.starts_with("x86_64") {
        elf[code_offset as usize] = 0xc3;
    } else {
        elf[code_offset as usize..code_offset as usize + 4]
            .copy_from_slice(&[0xc0, 0x03, 0x5f, 0xd6]);
    }

    write_u32(&mut elf, 320, 1);
    write_u32(&mut elf, 324, 3);
    write_u64(&mut elf, 344, names_offset);
    write_u64(&mut elf, 352, names.len() as u64);

    write_u32(&mut elf, 384, 11);
    write_u32(&mut elf, 388, 1);
    write_u64(&mut elf, 408, provenance_offset);
    write_u64(&mut elf, 416, provenance.len() as u64);
    write_u32(&mut elf, 448, 23);
    write_u32(&mut elf, 452, 1);
    write_u64(&mut elf, 472, audit_offset);
    write_u64(&mut elf, 480, audit_data.len() as u64);
    elf[names_offset as usize..names_offset as usize + names.len()].copy_from_slice(names);
    elf[provenance_offset as usize..audit_offset as usize].copy_from_slice(&provenance);
    elf[audit_offset as usize..].copy_from_slice(&audit_data);
    elf
}

fn write_u16(bytes: &mut [u8], offset: usize, value: u16) {
    bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}

fn write_u32(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn write_u64(bytes: &mut [u8], offset: usize, value: u64) {
    bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}

fn read_u64_at(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(bytes[offset..offset + 8].try_into().expect("u64 bytes"))
}

struct DigestWriter<'a>(&'a mut Sha256);

impl Write for DigestWriter<'_> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.0.update(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn shell_tree_digest(tree: &Path) -> String {
    let install_script =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../scripts/install-hmux.sh");
    let output = Command::new("sh")
        .arg(install_script)
        .arg("--print-prebuilt-digest")
        .env("HMUX_PREBUILT_DIR", tree)
        .output()
        .expect("shell digest");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout)
        .expect("digest UTF-8")
        .trim()
        .to_owned()
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) {
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).expect("permissions");
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) {}
