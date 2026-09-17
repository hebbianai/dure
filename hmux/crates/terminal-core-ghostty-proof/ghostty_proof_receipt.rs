use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Component, Path, PathBuf};

const RECEIPT_NAME: &str = "hmux-ghostty-vt-proof.receipt";
const EXACT_RECEIPT_SHA256: &str =
    "4f0939e9692cdcb2da76a910a76cfe497417d5dd714e449f848aa94d356fc567";

const V1_EXACT_FIELDS: &[(&str, &str)] = &[
    ("schema", "hmux-ghostty-vt-proof-v1"),
    ("target", "aarch64-apple-darwin"),
    ("ghostty_commit", "47147324cee9d12b537f0ea204bf16449d706b3a"),
    (
        "ghostty_source_tree",
        "f351e4e0e21c89ca8240e8f6d10f514aec129afe",
    ),
    (
        "ghostty_source_sha256",
        "60ed33a2bd972394cc55db5b90e948442c3fb3a8f6b46b52e89f176e9ff20ed7",
    ),
    (
        "ghostty_build_flags",
        "-Demit-lib-vt=true,-Demit-xcframework=false,-Doptimize=ReleaseSafe",
    ),
    ("zig_version", "0.16.0"),
    (
        "zig_archive_sha256",
        "b23d70deaa879b5c2d486ed3316f7eaa53e84acf6fc9cc747de152450d401489",
    ),
    (
        "zig_executable_sha256",
        "e6cd688d25664983833aae272f501d4bceeae304875b8f1741209d15fd13a4ec",
    ),
    (
        "uucode_package",
        "uucode-0.2.0-ZZjBPlK5VADj7fdoq7G8LIHzD5o6FSkcBXXrRWr4jnrA",
    ),
    (
        "uucode_archive_sha256",
        "3c571e2e2c1dd6d67d59e7a29322c718a90465ccb0df362e14feafcdde555ed0",
    ),
    (
        "headers_sha256",
        "e0c1f75eae1672ed1f39fb6b0557c7fe0ec0aa665f102347d261720ef039f151",
    ),
    (
        "library_sha256",
        "b3915b3075a04cb9d6b24463ce85d5109c5083979e239aa6cadaa9b2944114ae",
    ),
];

const V1_PATH_HASH_FIELDS: &[(&str, &str)] = &[
    ("ghostty_source_archive", "ghostty_source_sha256"),
    ("zig_archive", "zig_archive_sha256"),
    ("zig_executable", "zig_executable_sha256"),
    ("uucode_archive", "uucode_archive_sha256"),
    ("library", "library_sha256"),
];

const V2_SCHEMA: &str = "hmux-ghostty-vt-artifact-v2";
const V2_BUILD_OVERLAY_SHA256: &str =
    "bda20ad2ac3696716b3dbfcca4e70cd012aff598952966a9b3ed166110cbc799";
const V2_BUILD_FLAGS: &str = "-Demit-lib-vt=true,-Demit-xcframework=false,-Dsimd=true,-Doptimize=ReleaseFast,-Dstrip=true,-Dversion-string=1.3.2-dev";
const V2_HIGHWAY_PACKAGE: &str = "N-V-__8AAGmZhABbsPJLfbqrh6JTHsXhY6qCaLAQyx25e0XE";
const V2_HIGHWAY_ARCHIVE_SHA256: &str =
    "cf0f68a4275e59282383f46289da017166ea4cbbced04ad2af1b79f3eede3cc2";
const V2_HIGHWAY_TRANSPORT_SHA256: &str =
    "87d4f8893ef4e08f224973608ffebf94268a81380ba79c12e8841968c80aa212";
const V2_UUCODE_TRANSPORT_SHA256: &str =
    "7e76fc7fab1e7ac728c52b35bbb3e5b8c639841abfc7fe1a4bcb13050594bc9e";

struct PackagedArtifact {
    target: &'static str,
    recipe_id: &'static str,
    artifact_id: &'static str,
    receipt_sha256: &'static str,
}

// Legacy v2 supplies predate the reproducible v3 recipe and remain admitted by
// their exact reviewed receipt identities. V3 validates its closed recipe and
// content-addressed artifact at the single Cargo consumption boundary instead
// of requiring a second hand-maintained result registry.
const PACKAGED_ARTIFACTS: &[PackagedArtifact] = &[
    PackagedArtifact {
        target: "aarch64-apple-darwin",
        recipe_id: "ef34a3a88259be0fd407f623c7d66ebcf74465e7a8fe4332de156d2e3409b7e0",
        artifact_id: "d9925d74d38daaf4fddf99fd7e343f07c32deb1010791cf1f9b97f0be21c5b96",
        receipt_sha256: "092db6fdde4a829885f576b8dfc4501b2c042f8e795a0bf8c8e2c70d143407f5",
    },
    PackagedArtifact {
        target: "x86_64-unknown-linux-musl",
        recipe_id: "3d0bf468677c993f90b75001857605f38624de08532b44a662acc8289181e39c",
        artifact_id: "8307622fb55f4b5d160b55aaa7181af9e947c8d2a37b147238bcb22d87b30da2",
        receipt_sha256: "e1a13bef700478e3d7e5adce434df635b3c4d2653dffa314727492f47355a494",
    },
    PackagedArtifact {
        target: "aarch64-unknown-linux-musl",
        recipe_id: "7818511ee0175e0c476485d4842d303eac78fa2e957be1c8597f2041f6a759bd",
        artifact_id: "1619c96360f0e40e6a6f49e624f7a105db481b4d1ec1965986e1548671ac43e7",
        receipt_sha256: "254285248da29c6a7a4f8371615156ae353c63ad0bedaf41cf1a415dafcb3601",
    },
];

const V2_EXACT_FIELDS: &[(&str, &str)] = &[
    ("schema", V2_SCHEMA),
    ("ghostty_commit", "47147324cee9d12b537f0ea204bf16449d706b3a"),
    (
        "ghostty_source_tree",
        "f351e4e0e21c89ca8240e8f6d10f514aec129afe",
    ),
    (
        "ghostty_source_sha256",
        "60ed33a2bd972394cc55db5b90e948442c3fb3a8f6b46b52e89f176e9ff20ed7",
    ),
    (
        "ghostty_build_zig_sha256",
        "55ec6138c803afba0e8235156360a2e828e0023066e0bebb45956b8750812775",
    ),
    ("ghostty_build_overlay_sha256", V2_BUILD_OVERLAY_SHA256),
    ("ghostty_build_flags", V2_BUILD_FLAGS),
    ("zig_version", "0.16.0"),
    (
        "zig_archive_sha256",
        "b23d70deaa879b5c2d486ed3316f7eaa53e84acf6fc9cc747de152450d401489",
    ),
    (
        "zig_executable_sha256",
        "e6cd688d25664983833aae272f501d4bceeae304875b8f1741209d15fd13a4ec",
    ),
    (
        "uucode_package",
        "uucode-0.2.0-ZZjBPlK5VADj7fdoq7G8LIHzD5o6FSkcBXXrRWr4jnrA",
    ),
    (
        "uucode_archive_sha256",
        "3c571e2e2c1dd6d67d59e7a29322c718a90465ccb0df362e14feafcdde555ed0",
    ),
    ("uucode_transport_sha256", V2_UUCODE_TRANSPORT_SHA256),
    ("highway_package", V2_HIGHWAY_PACKAGE),
    ("highway_archive_sha256", V2_HIGHWAY_ARCHIVE_SHA256),
    ("highway_transport_sha256", V2_HIGHWAY_TRANSPORT_SHA256),
];

const V2_PATH_HASH_FIELDS: &[(&str, &str)] = &[
    ("ghostty_source_archive", "ghostty_source_sha256"),
    ("ghostty_build_overlay", "ghostty_build_overlay_sha256"),
    ("zig_archive", "zig_archive_sha256"),
    ("zig_executable", "zig_executable_sha256"),
    ("uucode_archive", "uucode_archive_sha256"),
    ("highway_archive", "highway_archive_sha256"),
    ("library", "library_sha256"),
];

const V3_SCHEMA: &str = "hmux-ghostty-vt-artifact-v3";
const V3_BUILD_OVERLAY_SHA256: &str =
    "9b4dba4ff70a0b5c8be27f08bc6adda9305548dd9de012f6a56d0799cee3dce2";
const V3_ARCHIVE_NORMALIZER: &str = "zig-ar-crsD-ranlib-D-v1";
const V3_BUILD_ENVIRONMENT: &str = "env-clear-lc-c-utc-proxy-deny-v1";
const V3_INPUT_STAGING: &str = "copy-rehash-build-owned-v1";

const V3_EXACT_FIELDS: &[(&str, &str)] = &[
    ("schema", V3_SCHEMA),
    ("ghostty_commit", "47147324cee9d12b537f0ea204bf16449d706b3a"),
    (
        "ghostty_source_tree",
        "f351e4e0e21c89ca8240e8f6d10f514aec129afe",
    ),
    (
        "ghostty_source_sha256",
        "60ed33a2bd972394cc55db5b90e948442c3fb3a8f6b46b52e89f176e9ff20ed7",
    ),
    (
        "ghostty_build_zig_sha256",
        "55ec6138c803afba0e8235156360a2e828e0023066e0bebb45956b8750812775",
    ),
    ("ghostty_build_overlay_sha256", V3_BUILD_OVERLAY_SHA256),
    ("ghostty_build_flags", V2_BUILD_FLAGS),
    ("archive_normalizer", V3_ARCHIVE_NORMALIZER),
    ("archive_member_count", "11"),
    ("build_environment", V3_BUILD_ENVIRONMENT),
    ("input_staging", V3_INPUT_STAGING),
    ("zig_version", "0.16.0"),
    (
        "zig_archive_sha256",
        "b23d70deaa879b5c2d486ed3316f7eaa53e84acf6fc9cc747de152450d401489",
    ),
    (
        "zig_executable_sha256",
        "e6cd688d25664983833aae272f501d4bceeae304875b8f1741209d15fd13a4ec",
    ),
    (
        "uucode_package",
        "uucode-0.2.0-ZZjBPlK5VADj7fdoq7G8LIHzD5o6FSkcBXXrRWr4jnrA",
    ),
    (
        "uucode_archive_sha256",
        "3c571e2e2c1dd6d67d59e7a29322c718a90465ccb0df362e14feafcdde555ed0",
    ),
    ("uucode_transport_sha256", V2_UUCODE_TRANSPORT_SHA256),
    ("highway_package", V2_HIGHWAY_PACKAGE),
    ("highway_archive_sha256", V2_HIGHWAY_ARCHIVE_SHA256),
    ("highway_transport_sha256", V2_HIGHWAY_TRANSPORT_SHA256),
];

const V3_PATH_HASH_FIELDS: &[(&str, &str)] = &[
    ("ghostty_source_archive", "ghostty_source_sha256"),
    ("ghostty_build_overlay", "ghostty_build_overlay_sha256"),
    ("zig_archive", "zig_archive_sha256"),
    ("zig_executable", "zig_executable_sha256"),
    ("uucode_archive", "uucode_archive_sha256"),
    ("highway_archive", "highway_archive_sha256"),
    ("library", "library_sha256"),
];

const V5_SCHEMA: &str = "hmux-ghostty-vt-artifact-v5";
const V5_EXACT_FIELDS: &[(&str, &str)] = &[
    ("schema", V5_SCHEMA),
    ("zig_target", "x86_64-windows-gnu"),
    ("ghostty_commit", "47147324cee9d12b537f0ea204bf16449d706b3a"),
    (
        "ghostty_source_tree",
        "f351e4e0e21c89ca8240e8f6d10f514aec129afe",
    ),
    (
        "ghostty_source_sha256",
        "60ed33a2bd972394cc55db5b90e948442c3fb3a8f6b46b52e89f176e9ff20ed7",
    ),
    (
        "ghostty_build_zig_sha256",
        "55ec6138c803afba0e8235156360a2e828e0023066e0bebb45956b8750812775",
    ),
    ("ghostty_build_overlay_sha256", V3_BUILD_OVERLAY_SHA256),
    ("ghostty_build_flags", V2_BUILD_FLAGS),
    (
        "archive_normalizer",
        "rust-1.85-llvm-19-objcopy-strip-debug-remove-addrsig-zig-ar-crsD-ranlib-D-lld-v3",
    ),
    ("archive_member_count", "11"),
    (
        "history_iterator_build_sha256",
        "e10884bb48a704f5e42ce2fe9ff32b297e526d18c1be3595a1c919a1335b8608",
    ),
    (
        "history_iterator_source_sha256",
        "f81a7642bebef6a1f3e21b9eaa43f69819cf98fd0aa93ce9a49734a5bbeda0dc",
    ),
    ("history_iterator_archive_member_count", "5"),
    (
        "rust_objcopy_sha256",
        "17e49737796f7f4c90a2884d6fb1f35c680f5025ce1f589a546a326713f1eebb",
    ),
    ("build_environment", V3_BUILD_ENVIRONMENT),
    ("input_staging", V3_INPUT_STAGING),
    ("zig_version", "0.16.0"),
    (
        "zig_archive_sha256",
        "b23d70deaa879b5c2d486ed3316f7eaa53e84acf6fc9cc747de152450d401489",
    ),
    (
        "zig_executable_sha256",
        "e6cd688d25664983833aae272f501d4bceeae304875b8f1741209d15fd13a4ec",
    ),
    (
        "uucode_package",
        "uucode-0.2.0-ZZjBPlK5VADj7fdoq7G8LIHzD5o6FSkcBXXrRWr4jnrA",
    ),
    (
        "uucode_archive_sha256",
        "3c571e2e2c1dd6d67d59e7a29322c718a90465ccb0df362e14feafcdde555ed0",
    ),
    ("uucode_transport_sha256", V2_UUCODE_TRANSPORT_SHA256),
    ("highway_package", V2_HIGHWAY_PACKAGE),
    ("highway_archive_sha256", V2_HIGHWAY_ARCHIVE_SHA256),
    ("highway_transport_sha256", V2_HIGHWAY_TRANSPORT_SHA256),
];

const V5_PATH_HASH_FIELDS: &[(&str, &str)] = &[
    ("ghostty_source_archive", "ghostty_source_sha256"),
    ("ghostty_build_overlay", "ghostty_build_overlay_sha256"),
    ("history_iterator_build", "history_iterator_build_sha256"),
    ("history_iterator_source", "history_iterator_source_sha256"),
    ("rust_objcopy", "rust_objcopy_sha256"),
    ("zig_archive", "zig_archive_sha256"),
    ("zig_executable", "zig_executable_sha256"),
    ("uucode_archive", "uucode_archive_sha256"),
    ("highway_archive", "highway_archive_sha256"),
    ("library", "library_sha256"),
    (
        "history_iterator_library",
        "history_iterator_library_sha256",
    ),
];

pub(crate) const PACKAGED_HOST_TARGETS: &[&str] = &[
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "aarch64-unknown-linux-musl",
    "x86_64-unknown-linux-musl",
    "x86_64-pc-windows-msvc",
];

pub(crate) struct ValidatedArtifacts {
    pub header_root: PathBuf,
    pub header_sha256: String,
    pub library: PathBuf,
    pub library_sha256: String,
    pub history_iterator_library: Option<PathBuf>,
    pub history_iterator_library_sha256: Option<String>,
    pub source_archive: PathBuf,
    pub source_archive_sha256: String,
    pub zig_archive: PathBuf,
    pub zig_archive_sha256: String,
    pub uucode_archive: PathBuf,
    pub uucode_archive_sha256: String,
    pub highway_archive: Option<PathBuf>,
    pub highway_archive_sha256: Option<String>,
    pub watched_paths: Vec<PathBuf>,
}

pub(crate) struct StagedArtifacts {
    pub include_dir: PathBuf,
    pub library: PathBuf,
    pub library_name: String,
    pub history_iterator_library: Option<PathBuf>,
    pub history_iterator_library_name: Option<String>,
    pub source_archive: PathBuf,
    pub zig_archive: PathBuf,
    pub uucode_archive: PathBuf,
    pub highway_archive: Option<PathBuf>,
    pub watched_paths: Vec<PathBuf>,
}

pub(crate) fn validate_and_stage(
    prefix: &Path,
    target: &str,
    out_dir: &Path,
) -> Result<StagedArtifacts, String> {
    stage(validate(prefix, target)?, out_dir)
}

pub(crate) fn validate(prefix: &Path, target: &str) -> Result<ValidatedArtifacts, String> {
    if !PACKAGED_HOST_TARGETS.contains(&target) {
        return Err(format!("unsupported Hmux Host target {target}"));
    }
    let prefix = prefix
        .canonicalize()
        .map_err(|error| format!("canonicalize proof prefix: {error}"))?;
    let receipt_path = prefix.join(RECEIPT_NAME);
    let receipt_bytes = fs::read(&receipt_path)
        .map_err(|error| format!("read {}: {error}", receipt_path.display()))?;
    let receipt_hash = sha256(&receipt_bytes);
    let receipt_text = std::str::from_utf8(&receipt_bytes)
        .map_err(|error| format!("receipt is not UTF-8: {error}"))?;
    let fields = parse(receipt_text)?;

    match required(&fields, "schema")? {
        "hmux-ghostty-vt-proof-v1" => validate_v1_receipt(&fields, &receipt_hash)?,
        V2_SCHEMA => validate_v2_receipt(&fields, target, &receipt_hash)?,
        V3_SCHEMA => validate_v3_receipt(&fields, target, &receipt_hash)?,
        V5_SCHEMA => validate_v5_receipt(&fields, target, &receipt_hash)?,
        schema => {
            return Err(format!(
                "unsupported Ghostty artifact receipt schema {schema}"
            ));
        }
    }

    if fields.get("target").map(String::as_str) != Some(target) {
        return Err(format!(
            "receipt target does not match Cargo TARGET {target}"
        ));
    }
    let mut watched_paths = vec![receipt_path];
    let path_fields = match required(&fields, "schema")? {
        V2_SCHEMA => V2_PATH_HASH_FIELDS,
        V3_SCHEMA => V3_PATH_HASH_FIELDS,
        V5_SCHEMA => V5_PATH_HASH_FIELDS,
        _ => V1_PATH_HASH_FIELDS,
    };
    for (path_field, hash_field) in path_fields {
        let path = resolve(&prefix, required(&fields, path_field)?)?;
        let actual = sha256_file(&path)?;
        let expected = required(&fields, hash_field)?;
        if actual != expected {
            return Err(format!(
                "{} SHA-256 {actual} does not match receipt {expected}",
                path.display()
            ));
        }
        watched_paths.push(path);
    }

    let header_root = resolve(&prefix, required(&fields, "headers")?)?;
    let (header_hash, header_paths) = sha256_header_tree(&header_root)?;
    let expected_header_hash = required(&fields, "headers_sha256")?;
    if header_hash != expected_header_hash {
        return Err(format!(
            "C header ABI SHA-256 {header_hash} does not match receipt {expected_header_hash}"
        ));
    }
    let library = resolve(&prefix, required(&fields, "library")?)?;
    let library_sha256 = required(&fields, "library_sha256")?.to_string();
    let history_iterator_library = fields
        .get("history_iterator_library")
        .map(|value| resolve(&prefix, value))
        .transpose()?;
    let history_iterator_library_sha256 = fields.get("history_iterator_library_sha256").cloned();
    let source_archive = resolve(&prefix, required(&fields, "ghostty_source_archive")?)?;
    let source_archive_sha256 = required(&fields, "ghostty_source_sha256")?.to_string();
    let zig_archive = resolve(&prefix, required(&fields, "zig_archive")?)?;
    let zig_archive_sha256 = required(&fields, "zig_archive_sha256")?.to_string();
    let uucode_archive = resolve(&prefix, required(&fields, "uucode_archive")?)?;
    let uucode_archive_sha256 = required(&fields, "uucode_archive_sha256")?.to_string();
    let highway_archive = fields
        .get("highway_archive")
        .map(|value| resolve(&prefix, value))
        .transpose()?;
    let highway_archive_sha256 = fields.get("highway_archive_sha256").cloned();
    watched_paths.extend(header_paths);

    Ok(ValidatedArtifacts {
        header_root,
        header_sha256: expected_header_hash.to_string(),
        library,
        library_sha256,
        history_iterator_library,
        history_iterator_library_sha256,
        source_archive,
        source_archive_sha256,
        zig_archive,
        zig_archive_sha256,
        uucode_archive,
        uucode_archive_sha256,
        highway_archive,
        highway_archive_sha256,
        watched_paths,
    })
}

fn validate_v1_receipt(
    fields: &BTreeMap<String, String>,
    receipt_hash: &str,
) -> Result<(), String> {
    if receipt_hash != EXACT_RECEIPT_SHA256 {
        return Err(format!(
            "receipt SHA-256 {receipt_hash} does not match exact reviewed receipt {EXACT_RECEIPT_SHA256}"
        ));
    }
    require_exact_fields(fields, V1_EXACT_FIELDS)?;
    require_closed_schema(fields, V1_EXACT_FIELDS, V1_PATH_HASH_FIELDS, &["headers"])
}

fn validate_v2_receipt(
    fields: &BTreeMap<String, String>,
    target: &str,
    receipt_hash: &str,
) -> Result<(), String> {
    let (recipe_id, artifact_id) = validate_content_addressed_receipt(
        fields,
        target,
        V2_EXACT_FIELDS,
        V2_PATH_HASH_FIELDS,
        packaged_v2_recipe_id,
        false,
    )?;
    let reviewed = PACKAGED_ARTIFACTS.iter().any(|entry| {
        entry.target == target
            && entry.recipe_id == recipe_id
            && entry.artifact_id == artifact_id
            && entry.receipt_sha256 == receipt_hash
    });
    if !reviewed {
        return Err(format!(
            "Ghostty artifact {target}/{recipe_id}/{artifact_id} is not in the reviewed v2 manifest"
        ));
    }
    Ok(())
}

fn validate_v3_receipt(
    fields: &BTreeMap<String, String>,
    target: &str,
    _receipt_hash: &str,
) -> Result<(), String> {
    validate_content_addressed_receipt(
        fields,
        target,
        V3_EXACT_FIELDS,
        V3_PATH_HASH_FIELDS,
        packaged_v3_recipe_id,
        false,
    )
    .map(|_| ())
}

fn validate_v5_receipt(
    fields: &BTreeMap<String, String>,
    target: &str,
    _receipt_hash: &str,
) -> Result<(), String> {
    validate_content_addressed_receipt(
        fields,
        target,
        V5_EXACT_FIELDS,
        V5_PATH_HASH_FIELDS,
        packaged_v5_recipe_id,
        true,
    )
    .map(|_| ())
}

fn validate_content_addressed_receipt(
    fields: &BTreeMap<String, String>,
    target: &str,
    exact_fields: &[(&str, &str)],
    path_hash_fields: &[(&str, &str)],
    recipe_identity: fn(&str) -> String,
    has_prebuilt_history_iterator: bool,
) -> Result<(String, String), String> {
    require_exact_fields(fields, exact_fields)?;
    for key in [
        "target",
        "recipe_id",
        "artifact_id",
        "headers",
        "headers_sha256",
        "library_sha256",
    ] {
        required(fields, key)?;
    }
    if has_prebuilt_history_iterator {
        required(fields, "history_iterator_library_sha256")?;
    }
    require_closed_schema(
        fields,
        exact_fields,
        path_hash_fields,
        &[
            "target",
            "recipe_id",
            "artifact_id",
            "headers",
            "headers_sha256",
        ],
    )?;
    if required(fields, "target")? != target {
        return Err(format!(
            "receipt target does not match Cargo TARGET {target}"
        ));
    }
    let recipe_id = recipe_identity(target);
    if required(fields, "recipe_id")? != recipe_id {
        return Err("receipt recipe_id does not match its reviewed recipe fields".into());
    }
    let identity = if has_prebuilt_history_iterator {
        format!(
            "schema=hmux-ghostty-vt-artifact-id-v2\nrecipe_id={recipe_id}\nheaders_sha256={}\nlibrary_sha256={}\nhistory_iterator_library_sha256={}\n",
            required(fields, "headers_sha256")?,
            required(fields, "library_sha256")?,
            required(fields, "history_iterator_library_sha256")?,
        )
    } else {
        format!(
            "schema=hmux-ghostty-vt-artifact-id-v1\nrecipe_id={recipe_id}\nheaders_sha256={}\nlibrary_sha256={}\n",
            required(fields, "headers_sha256")?,
            required(fields, "library_sha256")?,
        )
    };
    let artifact_id = sha256(identity.as_bytes());
    if required(fields, "artifact_id")? != artifact_id {
        return Err("receipt artifact_id does not match its reviewed artifact hashes".into());
    }
    Ok((recipe_id, artifact_id))
}

fn packaged_v2_recipe_id(target: &str) -> String {
    sha256(
        format!(
            "schema=hmux-ghostty-vt-recipe-v1\ntarget={target}\nghostty_commit=47147324cee9d12b537f0ea204bf16449d706b3a\nghostty_source_tree=f351e4e0e21c89ca8240e8f6d10f514aec129afe\nghostty_source_sha256=60ed33a2bd972394cc55db5b90e948442c3fb3a8f6b46b52e89f176e9ff20ed7\nghostty_build_zig_sha256=55ec6138c803afba0e8235156360a2e828e0023066e0bebb45956b8750812775\nghostty_build_overlay_sha256={V2_BUILD_OVERLAY_SHA256}\nghostty_build_flags={V2_BUILD_FLAGS}\nzig_version=0.16.0\nzig_archive_sha256=b23d70deaa879b5c2d486ed3316f7eaa53e84acf6fc9cc747de152450d401489\nzig_executable_sha256=e6cd688d25664983833aae272f501d4bceeae304875b8f1741209d15fd13a4ec\nuucode_package=uucode-0.2.0-ZZjBPlK5VADj7fdoq7G8LIHzD5o6FSkcBXXrRWr4jnrA\nuucode_archive_sha256=3c571e2e2c1dd6d67d59e7a29322c718a90465ccb0df362e14feafcdde555ed0\nhighway_package={V2_HIGHWAY_PACKAGE}\nhighway_archive_sha256={V2_HIGHWAY_ARCHIVE_SHA256}\n"
        )
        .as_bytes(),
    )
}

fn packaged_v3_recipe_id(target: &str) -> String {
    sha256(
        format!(
            "schema=hmux-ghostty-vt-recipe-v2\ntarget={target}\nghostty_commit=47147324cee9d12b537f0ea204bf16449d706b3a\nghostty_source_tree=f351e4e0e21c89ca8240e8f6d10f514aec129afe\nghostty_source_sha256=60ed33a2bd972394cc55db5b90e948442c3fb3a8f6b46b52e89f176e9ff20ed7\nghostty_build_zig_sha256=55ec6138c803afba0e8235156360a2e828e0023066e0bebb45956b8750812775\nghostty_build_overlay_sha256={V3_BUILD_OVERLAY_SHA256}\nghostty_build_flags={V2_BUILD_FLAGS}\narchive_normalizer={V3_ARCHIVE_NORMALIZER}\narchive_member_count=11\nbuild_environment={V3_BUILD_ENVIRONMENT}\ninput_staging={V3_INPUT_STAGING}\nzig_version=0.16.0\nzig_archive_sha256=b23d70deaa879b5c2d486ed3316f7eaa53e84acf6fc9cc747de152450d401489\nzig_executable_sha256=e6cd688d25664983833aae272f501d4bceeae304875b8f1741209d15fd13a4ec\nuucode_package=uucode-0.2.0-ZZjBPlK5VADj7fdoq7G8LIHzD5o6FSkcBXXrRWr4jnrA\nuucode_archive_sha256=3c571e2e2c1dd6d67d59e7a29322c718a90465ccb0df362e14feafcdde555ed0\nhighway_package={V2_HIGHWAY_PACKAGE}\nhighway_archive_sha256={V2_HIGHWAY_ARCHIVE_SHA256}\n"
        )
        .as_bytes(),
    )
}

fn packaged_v5_recipe_id(target: &str) -> String {
    sha256(
        format!(
            "schema=hmux-ghostty-vt-recipe-v4\ntarget={target}\nzig_target=x86_64-windows-gnu\nghostty_commit=47147324cee9d12b537f0ea204bf16449d706b3a\nghostty_source_tree=f351e4e0e21c89ca8240e8f6d10f514aec129afe\nghostty_source_sha256=60ed33a2bd972394cc55db5b90e948442c3fb3a8f6b46b52e89f176e9ff20ed7\nghostty_build_zig_sha256=55ec6138c803afba0e8235156360a2e828e0023066e0bebb45956b8750812775\nghostty_build_overlay_sha256={V3_BUILD_OVERLAY_SHA256}\nghostty_build_flags={V2_BUILD_FLAGS}\narchive_normalizer=rust-1.85-llvm-19-objcopy-strip-debug-remove-addrsig-zig-ar-crsD-ranlib-D-lld-v3\narchive_member_count=11\nhistory_iterator_build_sha256=e10884bb48a704f5e42ce2fe9ff32b297e526d18c1be3595a1c919a1335b8608\nhistory_iterator_source_sha256=f81a7642bebef6a1f3e21b9eaa43f69819cf98fd0aa93ce9a49734a5bbeda0dc\nhistory_iterator_archive_member_count=5\nrust_objcopy_sha256=17e49737796f7f4c90a2884d6fb1f35c680f5025ce1f589a546a326713f1eebb\nbuild_environment={V3_BUILD_ENVIRONMENT}\ninput_staging={V3_INPUT_STAGING}\nzig_version=0.16.0\nzig_archive_sha256=b23d70deaa879b5c2d486ed3316f7eaa53e84acf6fc9cc747de152450d401489\nzig_executable_sha256=e6cd688d25664983833aae272f501d4bceeae304875b8f1741209d15fd13a4ec\nuucode_package=uucode-0.2.0-ZZjBPlK5VADj7fdoq7G8LIHzD5o6FSkcBXXrRWr4jnrA\nuucode_archive_sha256=3c571e2e2c1dd6d67d59e7a29322c718a90465ccb0df362e14feafcdde555ed0\nhighway_package={V2_HIGHWAY_PACKAGE}\nhighway_archive_sha256={V2_HIGHWAY_ARCHIVE_SHA256}\n"
        )
        .as_bytes(),
    )
}

fn require_exact_fields(
    fields: &BTreeMap<String, String>,
    expected: &[(&str, &str)],
) -> Result<(), String> {
    for (key, value) in expected {
        let actual = required(fields, key)?;
        if actual != *value {
            return Err(format!(
                "receipt field {key} does not match the reviewed pin"
            ));
        }
    }
    Ok(())
}

fn require_closed_schema(
    fields: &BTreeMap<String, String>,
    exact: &[(&str, &str)],
    paths: &[(&str, &str)],
    additional: &[&str],
) -> Result<(), String> {
    let expected: BTreeSet<&str> = exact
        .iter()
        .map(|(key, _)| *key)
        .chain(paths.iter().flat_map(|(path, hash)| [*path, *hash]))
        .chain(additional.iter().copied())
        .collect();
    let actual: BTreeSet<&str> = fields.keys().map(String::as_str).collect();
    if actual != expected {
        return Err("receipt field set does not match the closed proof schema".into());
    }
    Ok(())
}

pub(crate) fn stage(
    artifacts: ValidatedArtifacts,
    out_dir: &Path,
) -> Result<StagedArtifacts, String> {
    if artifacts.highway_archive.is_some() != artifacts.highway_archive_sha256.is_some() {
        return Err("validated Highway archive path and hash must be present together".into());
    }
    if artifacts.history_iterator_library.is_some()
        != artifacts.history_iterator_library_sha256.is_some()
    {
        return Err("validated history iterator path and hash must be present together".into());
    }
    let content_identity = sha256(
        format!(
            "headers={}\nlibrary={}\nhistory_iterator={}\nsource={}\nzig={}\nuucode={}\nhighway={}\n",
            artifacts.header_sha256,
            artifacts.library_sha256,
            artifacts
                .history_iterator_library_sha256
                .as_deref()
                .unwrap_or("none"),
            artifacts.source_archive_sha256,
            artifacts.zig_archive_sha256,
            artifacts.uucode_archive_sha256,
            artifacts
                .highway_archive_sha256
                .as_deref()
                .unwrap_or("none"),
        )
        .as_bytes(),
    );
    let stage_root = out_dir.join(format!("ghostty-vt-proof-{content_identity}"));
    let include_dir = stage_root.join("include");
    let staged_headers = include_dir.join("ghostty");
    let provenance_dir = stage_root.join("provenance");
    let library_name = format!("ghostty-vt-{}", artifacts.library_sha256);
    let windows_artifact = artifacts.history_iterator_library.is_some();
    let staged_library = if windows_artifact {
        stage_root.join(format!("{library_name}.lib"))
    } else {
        stage_root.join(format!("lib{library_name}.a"))
    };
    let history_iterator_library_name = artifacts
        .history_iterator_library_sha256
        .as_ref()
        .map(|hash| format!("hmux-ghostty-history-iterator-{hash}"));
    let staged_history_iterator_library = history_iterator_library_name
        .as_ref()
        .map(|name| stage_root.join(format!("{name}.lib")));
    let staged_source_archive = provenance_dir.join("ghostty-source.tar.gz");
    let staged_zig_archive = provenance_dir.join("zig.tar.xz");
    let staged_uucode_archive = provenance_dir.join("uucode.tar.gz");
    let staged_highway_archive = artifacts
        .highway_archive
        .as_ref()
        .map(|_| provenance_dir.join("highway.tar.gz"));

    if !stage_root.exists() {
        fs::create_dir_all(&include_dir)
            .and_then(|_| fs::create_dir(&provenance_dir))
            .map_err(|error| format!("create staged include directory: {error}"))?;
        copy_regular_tree(&artifacts.header_root, &staged_headers)?;
        copy_regular_file(&artifacts.library, &staged_library)?;
        if let (Some(source), Some(destination)) = (
            &artifacts.history_iterator_library,
            &staged_history_iterator_library,
        ) {
            copy_regular_file(source, destination)?;
        }
        copy_regular_file(&artifacts.source_archive, &staged_source_archive)?;
        copy_regular_file(&artifacts.zig_archive, &staged_zig_archive)?;
        copy_regular_file(&artifacts.uucode_archive, &staged_uucode_archive)?;
        if let (Some(source), Some(destination)) =
            (&artifacts.highway_archive, &staged_highway_archive)
        {
            copy_regular_file(source, destination)?;
        }
    }

    ensure_regular_directory(&stage_root)?;
    ensure_regular_directory(&include_dir)?;
    ensure_regular_directory(&provenance_dir)?;
    let (staged_header_hash, _) = sha256_header_tree(&staged_headers)?;
    if staged_header_hash != artifacts.header_sha256 {
        return Err(format!(
            "staged C header closure SHA-256 {staged_header_hash} does not match validated {}",
            artifacts.header_sha256
        ));
    }
    let staged_library_hash = sha256_file(&staged_library)?;
    if staged_library_hash != artifacts.library_sha256 {
        return Err(format!(
            "staged Ghostty archive SHA-256 {staged_library_hash} does not match validated {}",
            artifacts.library_sha256
        ));
    }
    if let (Some(path), Some(expected)) = (
        &staged_history_iterator_library,
        &artifacts.history_iterator_library_sha256,
    ) {
        validate_staged_file(path, expected, "Ghostty history iterator archive")?;
    }
    validate_staged_file(
        &staged_source_archive,
        &artifacts.source_archive_sha256,
        "Ghostty source archive",
    )?;
    validate_staged_file(
        &staged_zig_archive,
        &artifacts.zig_archive_sha256,
        "Zig archive",
    )?;
    validate_staged_file(
        &staged_uucode_archive,
        &artifacts.uucode_archive_sha256,
        "uucode archive",
    )?;
    if let (Some(path), Some(expected)) =
        (&staged_highway_archive, &artifacts.highway_archive_sha256)
    {
        validate_staged_file(path, expected, "Highway archive")?;
    }

    Ok(StagedArtifacts {
        include_dir,
        library: staged_library,
        library_name,
        history_iterator_library: staged_history_iterator_library,
        history_iterator_library_name,
        source_archive: staged_source_archive,
        zig_archive: staged_zig_archive,
        uucode_archive: staged_uucode_archive,
        highway_archive: staged_highway_archive,
        watched_paths: artifacts.watched_paths,
    })
}

fn validate_staged_file(path: &Path, expected: &str, label: &str) -> Result<(), String> {
    let actual = sha256_file(path)?;
    if actual != expected {
        return Err(format!(
            "staged {label} SHA-256 {actual} does not match validated {expected}"
        ));
    }
    Ok(())
}

fn parse(contents: &str) -> Result<BTreeMap<String, String>, String> {
    let mut fields = BTreeMap::new();
    for (index, line) in contents.lines().enumerate() {
        let (key, value) = line
            .split_once('=')
            .ok_or_else(|| format!("receipt line {} is not key=value", index + 1))?;
        if key.is_empty() || value.is_empty() || fields.insert(key.into(), value.into()).is_some() {
            return Err(format!("receipt line {} is empty or duplicated", index + 1));
        }
    }

    Ok(fields)
}

fn required<'a>(fields: &'a BTreeMap<String, String>, key: &str) -> Result<&'a str, String> {
    fields
        .get(key)
        .map(String::as_str)
        .ok_or_else(|| format!("receipt field {key} is missing"))
}

fn resolve(prefix: &Path, value: &str) -> Result<PathBuf, String> {
    let relative = Path::new(value);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!("receipt path {value} is not a safe relative path"));
    }
    let mut path = prefix.to_path_buf();
    let component_count = relative.components().count();
    for (index, component) in relative.components().enumerate() {
        let Component::Normal(component) = component else {
            return Err(format!("receipt path {value} is not a safe relative path"));
        };
        path.push(component);
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("inspect {}: {error}", path.display()))?;
        if metadata.file_type().is_symlink() {
            return Err(format!("receipt path contains symlink {}", path.display()));
        }
        if index + 1 != component_count && !metadata.is_dir() {
            return Err(format!(
                "receipt path component is not a directory {}",
                path.display()
            ));
        }
    }
    Ok(path)
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("inspect {}: {error}", path.display()))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(format!(
            "artifact is not one regular file {}",
            path.display()
        ));
    }
    let bytes = fs::read(path).map_err(|error| format!("read {}: {error}", path.display()))?;
    Ok(sha256(&bytes))
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(crate) fn sha256_header_tree(root: &Path) -> Result<(String, Vec<PathBuf>), String> {
    let metadata = fs::symlink_metadata(root)
        .map_err(|error| format!("inspect header root {}: {error}", root.display()))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(format!(
            "header root is not one regular directory {}",
            root.display()
        ));
    }
    let mut files = Vec::new();
    let mut directories = Vec::new();
    collect_headers(root, root, &mut files, &mut directories)?;
    files.sort_by(|left, right| left.0.cmp(&right.0));
    directories.sort();
    let mut digest = Sha256::new();
    for (relative, path) in &files {
        let bytes = fs::read(path).map_err(|error| format!("read {}: {error}", path.display()))?;
        digest.update(relative.as_bytes());
        digest.update([0]);
        digest.update((bytes.len() as u64).to_le_bytes());
        digest.update(bytes);
    }
    directories.extend(files.into_iter().map(|(_, path)| path));
    Ok((format!("{:x}", digest.finalize()), directories))
}

fn collect_headers(
    root: &Path,
    directory: &Path,
    output: &mut Vec<(String, PathBuf)>,
    directories: &mut Vec<PathBuf>,
) -> Result<(), String> {
    directories.push(directory.to_path_buf());
    for entry in fs::read_dir(directory)
        .map_err(|error| format!("read directory {}: {error}", directory.display()))?
    {
        let entry = entry.map_err(|error| format!("read directory entry: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("read type for {}: {error}", entry.path().display()))?;
        if file_type.is_symlink() {
            return Err(format!(
                "header tree contains symlink {}",
                entry.path().display()
            ));
        }
        if file_type.is_dir() {
            collect_headers(root, &entry.path(), output, directories)?;
        } else if file_type.is_file() {
            let relative = entry
                .path()
                .strip_prefix(root)
                .map_err(|error| format!("resolve header path: {error}"))?
                .to_string_lossy()
                .replace('\\', "/");
            output.push((relative, entry.path()));
        } else {
            return Err(format!(
                "header closure contains special file {}",
                entry.path().display()
            ));
        }
    }
    Ok(())
}

fn copy_regular_tree(source: &Path, destination: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("inspect source directory {}: {error}", source.display()))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(format!(
            "source closure is not one regular directory {}",
            source.display()
        ));
    }
    fs::create_dir(destination)
        .map_err(|error| format!("create staged directory {}: {error}", destination.display()))?;
    let mut entries = fs::read_dir(source)
        .map_err(|error| format!("read source directory {}: {error}", source.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read source directory entry: {error}"))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let file_type = entry
            .file_type()
            .map_err(|error| format!("read type for {}: {error}", entry.path().display()))?;
        let staged = destination.join(entry.file_name());
        if file_type.is_symlink() {
            return Err(format!(
                "source closure contains symlink {}",
                entry.path().display()
            ));
        }
        if file_type.is_dir() {
            copy_regular_tree(&entry.path(), &staged)?;
        } else if file_type.is_file() {
            copy_regular_file(&entry.path(), &staged)?;
        } else {
            return Err(format!(
                "source closure contains special file {}",
                entry.path().display()
            ));
        }
    }
    Ok(())
}

fn copy_regular_file(source: &Path, destination: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("inspect source artifact {}: {error}", source.display()))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(format!(
            "source artifact is not one regular file {}",
            source.display()
        ));
    }
    fs::copy(source, destination).map_err(|error| {
        format!(
            "copy source artifact {} to {}: {error}",
            source.display(),
            destination.display()
        )
    })?;
    Ok(())
}

fn ensure_regular_directory(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("inspect staged directory {}: {error}", path.display()))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(format!(
            "staged closure path is not one regular directory {}",
            path.display()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_v3_artifact_needs_no_second_result_registry() {
        let target = "x86_64-apple-darwin";
        let mut fields = V3_EXACT_FIELDS
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect::<BTreeMap<_, _>>();
        for (path_field, hash_field) in V3_PATH_HASH_FIELDS {
            fields
                .entry((*path_field).to_string())
                .or_insert_with(|| format!("provenance/{path_field}"));
            fields
                .entry((*hash_field).to_string())
                .or_insert_with(|| format!("{hash_field}-sha256"));
        }
        let recipe_id = packaged_v3_recipe_id(target);
        let headers_sha256 = "generated-headers-sha256";
        let library_sha256 = "generated-library-sha256";
        let artifact_id = sha256(
            format!(
                "schema=hmux-ghostty-vt-artifact-id-v1\nrecipe_id={recipe_id}\nheaders_sha256={headers_sha256}\nlibrary_sha256={library_sha256}\n"
            )
            .as_bytes(),
        );
        fields.insert("target".into(), target.into());
        fields.insert("recipe_id".into(), recipe_id);
        fields.insert("artifact_id".into(), artifact_id);
        fields.insert("headers".into(), "include/ghostty".into());
        fields.insert("headers_sha256".into(), headers_sha256.into());
        fields.insert("library_sha256".into(), library_sha256.into());

        validate_v3_receipt(&fields, target, "generated-receipt-sha256").unwrap();
    }

    #[test]
    fn packaged_windows_recipe_identity_matches_the_supply_contract() {
        assert_eq!(
            packaged_v5_recipe_id("x86_64-pc-windows-msvc"),
            "3be79c8512bfecbecfe2850b7ee872f2cd4c79ef3c06c915bd7d4babe91a58f1"
        );
    }
}
