use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::ffi::{CStr, CString, OsStr, OsString};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read};
use std::mem::MaybeUninit;
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use tar::Archive;

const RECEIPT_NAME: &str = "hmux-ghostty-vt-proof.receipt";
const RECEIPT_SCHEMA: &str = "hmux-ghostty-vt-artifact-v3";
const RECIPE_SCHEMA: &str = "hmux-ghostty-vt-recipe-v2";
const WINDOWS_RECEIPT_SCHEMA: &str = "hmux-ghostty-vt-artifact-v5";
const WINDOWS_RECIPE_SCHEMA: &str = "hmux-ghostty-vt-recipe-v4";
const ARCHIVE_NORMALIZER: &str = "zig-ar-crsD-ranlib-D-v1";
const WINDOWS_ARCHIVE_NORMALIZER: &str =
    "rust-1.85-llvm-19-objcopy-strip-debug-remove-addrsig-zig-ar-crsD-ranlib-D-lld-v3";
const ARCHIVE_MEMBER_COUNT: usize = 11;
const HISTORY_ITERATOR_ARCHIVE_MEMBER_COUNT: usize = 5;
const BUILD_ENVIRONMENT: &str = "env-clear-lc-c-utc-proxy-deny-v1";
const INPUT_STAGING: &str = "copy-rehash-build-owned-v1";
const WINDOWS_TARGET: &str = "x86_64-pc-windows-msvc";
const WINDOWS_ZIG_TARGET: &str = "x86_64-windows-gnu";
const WINDOWS_LIBRARY_NAME: &str = "ghostty-vt-static.lib";
const WINDOWS_HISTORY_ITERATOR_LIBRARY_NAME: &str = "hmux-ghostty-history-iterator.lib";
const RUST_OBJCOPY_SHA256: &str =
    "17e49737796f7f4c90a2884d6fb1f35c680f5025ce1f589a546a326713f1eebb";

const GHOSTTY_COMMIT: &str = "47147324cee9d12b537f0ea204bf16449d706b3a";
const GHOSTTY_SOURCE_TREE: &str = "f351e4e0e21c89ca8240e8f6d10f514aec129afe";
const GHOSTTY_SOURCE_SHA256: &str =
    "60ed33a2bd972394cc55db5b90e948442c3fb3a8f6b46b52e89f176e9ff20ed7";
const GHOSTTY_BUILD_ZIG_SHA256: &str =
    "55ec6138c803afba0e8235156360a2e828e0023066e0bebb45956b8750812775";
const BUILD_OVERLAY_SHA256: &str =
    "9b4dba4ff70a0b5c8be27f08bc6adda9305548dd9de012f6a56d0799cee3dce2";
const BUILD_OVERLAY: &[u8] = include_bytes!("../supply/libghostty-vt-build.zig");
const HISTORY_ITERATOR_BUILD: &[u8] = include_bytes!("ghostty_history_iterator_build.zig");
const HISTORY_ITERATOR_BUILD_SHA256: &str =
    "e10884bb48a704f5e42ce2fe9ff32b297e526d18c1be3595a1c919a1335b8608";
const HISTORY_ITERATOR_SOURCE: &[u8] = include_bytes!("ghostty_history_iterator.zig");
const HISTORY_ITERATOR_SOURCE_SHA256: &str =
    "f81a7642bebef6a1f3e21b9eaa43f69819cf98fd0aa93ce9a49734a5bbeda0dc";
const BUILD_FLAGS: &str = "-Demit-lib-vt=true,-Demit-xcframework=false,-Dsimd=true,-Doptimize=ReleaseFast,-Dstrip=true,-Dversion-string=1.3.2-dev";

const ZIG_VERSION: &str = "0.16.0";
const ZIG_ARCHIVE_SHA256: &str = "b23d70deaa879b5c2d486ed3316f7eaa53e84acf6fc9cc747de152450d401489";
const ZIG_EXECUTABLE_SHA256: &str =
    "e6cd688d25664983833aae272f501d4bceeae304875b8f1741209d15fd13a4ec";

const UUCODE_PACKAGE: &str = "uucode-0.2.0-ZZjBPlK5VADj7fdoq7G8LIHzD5o6FSkcBXXrRWr4jnrA";
const UUCODE_ARCHIVE_SHA256: &str =
    "3c571e2e2c1dd6d67d59e7a29322c718a90465ccb0df362e14feafcdde555ed0";
const UUCODE_TRANSPORT_SHA256: &str =
    "7e76fc7fab1e7ac728c52b35bbb3e5b8c639841abfc7fe1a4bcb13050594bc9e";
const HIGHWAY_PACKAGE: &str = "N-V-__8AAGmZhABbsPJLfbqrh6JTHsXhY6qCaLAQyx25e0XE";
const HIGHWAY_ARCHIVE_SHA256: &str =
    "cf0f68a4275e59282383f46289da017166ea4cbbced04ad2af1b79f3eede3cc2";
const HIGHWAY_TRANSPORT_SHA256: &str =
    "87d4f8893ef4e08f224973608ffebf94268a81380ba79c12e8841968c80aa212";

const HOST_TARGETS: &[(&str, &str)] = &[
    ("aarch64-apple-darwin", "aarch64-macos"),
    ("x86_64-apple-darwin", "x86_64-macos"),
    ("aarch64-unknown-linux-musl", "aarch64-linux-musl"),
    ("x86_64-unknown-linux-musl", "x86_64-linux-musl"),
    (WINDOWS_TARGET, WINDOWS_ZIG_TARGET),
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ArtifactLayout {
    UnixV3,
    WindowsV4,
}

impl ArtifactLayout {
    fn for_target(target: &str) -> Self {
        if target == WINDOWS_TARGET {
            Self::WindowsV4
        } else {
            Self::UnixV3
        }
    }

    fn library_name(self) -> &'static str {
        match self {
            Self::UnixV3 => "libghostty-vt.a",
            Self::WindowsV4 => WINDOWS_LIBRARY_NAME,
        }
    }

    fn object_extension(self) -> &'static str {
        match self {
            Self::UnixV3 => "o",
            Self::WindowsV4 => "obj",
        }
    }
}

#[derive(Debug)]
struct Options {
    ghostty_source: PathBuf,
    zig_archive: PathBuf,
    zig: PathBuf,
    objcopy: Option<PathBuf>,
    uucode_cache: PathBuf,
    highway_cache: PathBuf,
    target: String,
    output: PathBuf,
}

#[derive(Debug, Eq, PartialEq)]
pub struct StagedSupply {
    pub recipe_id: String,
    pub artifact_id: String,
    pub artifact_root: PathBuf,
}

pub fn run_cli(arguments: impl IntoIterator<Item = OsString>) -> Result<StagedSupply, String> {
    let options = parse_options(arguments)?;
    stage(options)
}

fn parse_options(arguments: impl IntoIterator<Item = OsString>) -> Result<Options, String> {
    let mut arguments = arguments.into_iter();
    let _program = arguments.next();
    let mut values = BTreeMap::<String, OsString>::new();
    while let Some(flag) = arguments.next() {
        let flag = flag
            .into_string()
            .map_err(|_| "command option is not valid UTF-8".to_string())?;
        if !flag.starts_with("--") {
            return Err(format!("unexpected positional argument {flag}"));
        }
        let value = arguments
            .next()
            .ok_or_else(|| format!("option {flag} requires a value"))?;
        if values.insert(flag.clone(), value).is_some() {
            return Err(format!("option {flag} was provided more than once"));
        }
    }
    let objcopy = values.remove("--objcopy").map(PathBuf::from);
    let mut take = |name: &str| {
        values
            .remove(name)
            .ok_or_else(|| format!("required option {name} is missing"))
    };
    let options = Options {
        ghostty_source: take("--ghostty-source")?.into(),
        zig_archive: take("--zig-archive")?.into(),
        zig: take("--zig")?.into(),
        objcopy,
        uucode_cache: take("--uucode-cache")?.into(),
        highway_cache: take("--highway-cache")?.into(),
        target: take("--target")?
            .into_string()
            .map_err(|_| "--target is not valid UTF-8".to_string())?,
        output: take("--output")?.into(),
    };
    if let Some((unknown, _)) = values.into_iter().next() {
        return Err(format!("unknown option {unknown}"));
    }
    Ok(options)
}

fn stage(options: Options) -> Result<StagedSupply, String> {
    let layout = ArtifactLayout::for_target(&options.target);
    let zig_target = HOST_TARGETS
        .iter()
        .find_map(|(target, zig)| (*target == options.target).then_some(*zig))
        .ok_or_else(|| format!("unsupported Hmux Host target {}", options.target))?;
    validate_file(&options.ghostty_source, GHOSTTY_SOURCE_SHA256)?;
    validate_file(&options.zig_archive, ZIG_ARCHIVE_SHA256)?;
    validate_file(&options.zig, ZIG_EXECUTABLE_SHA256)?;
    validate_file(&options.uucode_cache, UUCODE_ARCHIVE_SHA256)?;
    validate_file(&options.highway_cache, HIGHWAY_ARCHIVE_SHA256)?;
    if sha256(BUILD_OVERLAY) != BUILD_OVERLAY_SHA256 {
        return Err("checked-in Ghostty build overlay does not match its reviewed pin".into());
    }
    if layout == ArtifactLayout::WindowsV4
        && (sha256(HISTORY_ITERATOR_BUILD) != HISTORY_ITERATOR_BUILD_SHA256
            || sha256(HISTORY_ITERATOR_SOURCE) != HISTORY_ITERATOR_SOURCE_SHA256)
    {
        return Err("checked-in history iterator sources do not match their reviewed pins".into());
    }
    let objcopy = match (layout, options.objcopy.as_ref()) {
        (ArtifactLayout::WindowsV4, Some(path)) => {
            validate_file(path, RUST_OBJCOPY_SHA256)?;
            Some(path)
        }
        (ArtifactLayout::WindowsV4, None) => {
            return Err("Windows Ghostty supply requires --objcopy".into());
        }
        (ArtifactLayout::UnixV3, Some(_)) => {
            return Err("--objcopy is reserved for the Windows Ghostty supply".into());
        }
        (ArtifactLayout::UnixV3, None) => None,
    };

    let recipe = recipe_text(&options.target);
    let recipe_id = sha256(recipe.as_bytes());

    let (output, output_directory) = prepare_output_directory(&options.output)?;
    let temporary = tempfile::Builder::new()
        .prefix(".ghostty-vt-stage-")
        .permissions(fs::Permissions::from_mode(0o700))
        .tempdir_in(&output)
        .map_err(|error| format!("create build-owned staging root: {error}"))?;
    ensure_owner_only_directory(temporary.path())?;
    let temporary_directory = open_directory_nofollow(temporary.path())
        .map_err(|error| format!("open build-owned staging root: {error}"))?;
    validate_owned_directory_descriptor(&temporary_directory)
        .map_err(|error| format!("validate build-owned staging root: {error}"))?;
    validate_path_matches_directory(temporary.path(), &temporary_directory)
        .map_err(|error| format!("validate build-owned staging generation: {error}"))?;
    let build_root = temporary.path().join("build");
    let source_root = build_root.join("source");
    let provenance = build_root.join("provenance");
    let global_cache = build_root.join("zig-global-cache");
    let local_cache = build_root.join("zig-local-cache");
    let install = build_root.join("install");
    let zig_toolchain = build_root.join("zig-toolchain");
    fs::create_dir_all(&provenance)
        .and_then(|_| fs::create_dir_all(global_cache.join("p")))
        .map_err(|error| format!("create isolated build directories: {error}"))?;

    let copied_source = provenance.join("ghostty-source.tar.gz");
    let copied_zig_archive = provenance.join("zig.tar.xz");
    let copied_zig = provenance.join("zig");
    let copied_objcopy = provenance.join("rust-objcopy");
    let copied_uucode = provenance.join(format!("{UUCODE_PACKAGE}.tar.gz"));
    let copied_highway = provenance.join(format!("{HIGHWAY_PACKAGE}.tar.gz"));
    let copied_overlay = provenance.join("libghostty-vt-build.zig");
    let copied_iterator_build = provenance.join("ghostty-history-iterator-build.zig");
    let copied_iterator_source = provenance.join("ghostty-history-iterator.zig");
    copy_regular_file(&options.ghostty_source, &copied_source)?;
    copy_regular_file(&options.zig_archive, &copied_zig_archive)?;
    copy_regular_file(&options.zig, &copied_zig)?;
    if let Some(objcopy) = objcopy {
        copy_regular_file(objcopy, &copied_objcopy)?;
    }
    copy_regular_file(&options.uucode_cache, &copied_uucode)?;
    copy_regular_file(&options.highway_cache, &copied_highway)?;
    fs::write(&copied_overlay, BUILD_OVERLAY)
        .map_err(|error| format!("copy build overlay into provenance: {error}"))?;
    if layout == ArtifactLayout::WindowsV4 {
        fs::write(&copied_iterator_build, HISTORY_ITERATOR_BUILD)
            .and_then(|_| fs::write(&copied_iterator_source, HISTORY_ITERATOR_SOURCE))
            .map_err(|error| format!("copy history iterator sources into provenance: {error}"))?;
    }
    validate_file(&copied_source, GHOSTTY_SOURCE_SHA256)?;
    validate_file(&copied_zig_archive, ZIG_ARCHIVE_SHA256)?;
    validate_file(&copied_zig, ZIG_EXECUTABLE_SHA256)?;
    validate_file(&copied_uucode, UUCODE_ARCHIVE_SHA256)?;
    validate_file(&copied_highway, HIGHWAY_ARCHIVE_SHA256)?;
    validate_file(&copied_overlay, BUILD_OVERLAY_SHA256)?;
    if layout == ArtifactLayout::WindowsV4 {
        validate_file(&copied_objcopy, RUST_OBJCOPY_SHA256)?;
        validate_file(&copied_iterator_build, HISTORY_ITERATOR_BUILD_SHA256)?;
        validate_file(&copied_iterator_source, HISTORY_ITERATOR_SOURCE_SHA256)?;
        make_executable(&copied_objcopy)?;
    }
    make_executable(&copied_zig)?;
    let build_zig = extract_zig_toolchain(&copied_zig_archive, &zig_toolchain)?;
    validate_file(&build_zig, ZIG_EXECUTABLE_SHA256)?;
    extract_source(&copied_source, &source_root)?;
    let original_build_zig = source_root.join("build.zig");
    validate_file(&original_build_zig, GHOSTTY_BUILD_ZIG_SHA256)?;
    fs::write(&original_build_zig, BUILD_OVERLAY)
        .map_err(|error| format!("install reviewed Ghostty build overlay: {error}"))?;
    copy_regular_file(
        &copied_uucode,
        &global_cache
            .join("p")
            .join(format!("{UUCODE_PACKAGE}.tar.gz")),
    )?;
    copy_regular_file(
        &copied_highway,
        &global_cache
            .join("p")
            .join(format!("{HIGHWAY_PACKAGE}.tar.gz")),
    )?;

    run_zig(
        &build_zig,
        &source_root,
        &global_cache,
        &local_cache,
        &install,
        zig_target,
    )?;
    let headers = install.join("include/ghostty");
    let library = install.join("lib").join(layout.library_name());
    normalize_static_archive(
        &build_zig,
        &library,
        &build_root,
        layout.object_extension(),
        ARCHIVE_MEMBER_COUNT,
        "ghostty-vt",
        (layout == ArtifactLayout::WindowsV4).then_some(copied_objcopy.as_path()),
    )?;
    let history_iterator = if layout == ArtifactLayout::WindowsV4 {
        let library = build_history_iterator(
            &build_zig,
            &source_root,
            &global_cache,
            &build_root,
            zig_target,
        )?;
        normalize_static_archive(
            &build_zig,
            &library,
            &build_root,
            layout.object_extension(),
            HISTORY_ITERATOR_ARCHIVE_MEMBER_COUNT,
            "ghostty-history-iterator",
            Some(copied_objcopy.as_path()),
        )?;
        Some(library)
    } else {
        None
    };
    validate_cache_closure(&global_cache.join("p"))?;
    let headers_sha256 = sha256_tree(&headers)?;
    let library_sha256 = sha256_file(&library)?;
    let history_iterator_sha256 = history_iterator
        .as_ref()
        .map(|library| sha256_file(library))
        .transpose()?;
    let artifact_id = artifact_identity(
        &recipe_id,
        &headers_sha256,
        &library_sha256,
        history_iterator_sha256.as_deref(),
    );

    let bundle = temporary.path().join("bundle");
    fs::create_dir_all(bundle.join("include"))
        .and_then(|_| fs::create_dir_all(bundle.join("lib")))
        .map_err(|error| format!("create immutable artifact bundle: {error}"))?;
    copy_regular_tree(&headers, &bundle.join("include/ghostty"))?;
    copy_regular_file(&library, &bundle.join("lib").join(layout.library_name()))?;
    if let Some(history_iterator) = history_iterator.as_ref() {
        copy_regular_file(
            history_iterator,
            &bundle
                .join("lib")
                .join(WINDOWS_HISTORY_ITERATOR_LIBRARY_NAME),
        )?;
    }
    copy_regular_tree(&provenance, &bundle.join("provenance"))?;
    let receipt = receipt_text(
        &options.target,
        &recipe_id,
        &artifact_id,
        &headers_sha256,
        &library_sha256,
        history_iterator_sha256.as_deref(),
    );
    fs::write(bundle.join(RECEIPT_NAME), receipt.as_bytes())
        .map_err(|error| format!("write immutable artifact receipt: {error}"))?;
    harden_bundle_permissions(&bundle)?;

    let recipe_root = output.join(&recipe_id);
    let target_root = recipe_root.join(&options.target);
    let publication = publication_target(&output_directory, &recipe_id, &options.target)
        .map_err(|error| format!("create no-follow recipe target directory: {error}"))?;
    let artifact_root = target_root.join(&artifact_id);
    match publish_bundle_noreplace(
        &temporary_directory,
        OsStr::new("bundle"),
        &publication.target,
        &artifact_id,
    ) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => {
            return Err(format!(
                "publish immutable Ghostty artifact without replacement: {error}"
            ));
        }
    }
    let artifact_directory = open_directory_at(&publication.target, OsStr::new(&artifact_id))
        .map_err(|error| format!("open immutable Ghostty artifact without aliases: {error}"))?;
    ensure_existing_artifact(
        &artifact_directory,
        &artifact_root,
        receipt.as_bytes(),
        &headers_sha256,
        &library_sha256,
        history_iterator_sha256.as_deref(),
    )?;
    validate_path_matches_directory(&output, &output_directory)
        .map_err(|error| format!("validate Ghostty output generation: {error}"))?;
    validate_path_matches_directory(&recipe_root, &publication.recipe)
        .map_err(|error| format!("validate Ghostty recipe generation: {error}"))?;
    validate_path_matches_directory(&target_root, &publication.target)
        .map_err(|error| format!("validate Ghostty target generation: {error}"))?;
    validate_path_matches_directory(&artifact_root, &artifact_directory)
        .map_err(|error| format!("validate immutable Ghostty artifact generation: {error}"))?;
    Ok(StagedSupply {
        recipe_id,
        artifact_id,
        artifact_root,
    })
}

fn build_history_iterator(
    zig: &Path,
    source: &Path,
    global_cache: &Path,
    build_root: &Path,
    zig_target: &str,
) -> Result<PathBuf, String> {
    fs::write(source.join("build.zig"), HISTORY_ITERATOR_BUILD)
        .and_then(|_| {
            fs::write(
                source.join("hmux_history_iterator.zig"),
                HISTORY_ITERATOR_SOURCE,
            )
        })
        .map_err(|error| format!("install reviewed history iterator sources: {error}"))?;
    expose_pinned_terminal_internals(source)?;
    let local_cache = build_root.join("history-iterator-zig-local-cache");
    let install = build_root.join("history-iterator-install");
    run_zig(
        zig,
        source,
        global_cache,
        &local_cache,
        &install,
        zig_target,
    )?;
    let library = install
        .join("lib")
        .join(WINDOWS_HISTORY_ITERATOR_LIBRARY_NAME);
    validate_file_shape(&library)?;
    Ok(library)
}

fn expose_pinned_terminal_internals(source: &Path) -> Result<(), String> {
    let lib_vt = source.join("src/lib_vt.zig");
    let contents = fs::read_to_string(&lib_vt)
        .map_err(|error| format!("read exact-pin Zig module: {error}"))?;
    let declaration = "const terminal = @import(\"terminal/main.zig\");";
    if contents.matches(declaration).count() != 1 {
        return Err("exact-pin Zig module terminal declaration changed".into());
    }
    let exposed = contents.replacen(
        declaration,
        &format!(
            "{declaration}\n\n/// Hmux exact-pin leaf access; never exported on the product wire.\n\
             pub const hmux_c_api = terminal.c_api;\n\
             /// Native Page/snapshot access for the opaque cold archive.\n\
             pub const hmux_terminal = terminal;"
        ),
        1,
    );
    fs::write(&lib_vt, exposed)
        .map_err(|error| format!("install exact-pin Hmux internal seam: {error}"))
}

fn normalize_static_archive(
    zig: &Path,
    library: &Path,
    build_root: &Path,
    object_extension: &str,
    member_count: usize,
    label: &str,
    objcopy: Option<&Path>,
) -> Result<(), String> {
    validate_file_shape(library)?;
    let members = archive_members(zig, library)?;
    let mut sorted = BTreeMap::<String, String>::new();
    for member in members {
        let basename = Path::new(&member)
            .file_name()
            .and_then(OsStr::to_str)
            .ok_or_else(|| format!("archive member does not have one UTF-8 basename: {member}"))?
            .to_string();
        if Path::new(&basename).extension() != Some(OsStr::new(object_extension)) {
            return Err(format!("archive member is not one object file: {member}"));
        }
        if sorted.insert(basename.clone(), member).is_some() {
            return Err(format!("archive has duplicate object basename {basename}"));
        }
    }
    if sorted.len() != member_count {
        return Err(format!(
            "archive has {} objects; reviewed normalizer requires {member_count}",
            sorted.len()
        ));
    }

    let extracted = build_root.join(format!("normalized-{label}-archive-members"));
    let raw = if objcopy.is_some() {
        fs::create_dir(&extracted)
            .map_err(|error| format!("create normalized archive member root: {error}"))?;
        build_root.join(format!("raw-{label}-archive-members"))
    } else {
        extracted.clone()
    };
    fs::create_dir(&raw).map_err(|error| format!("create raw archive member root: {error}"))?;
    for (basename, member) in &sorted {
        let raw_destination = raw.join(basename);
        let output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&raw_destination)
            .map_err(|error| format!("create normalized object {basename}: {error}"))?;
        let status = hermetic_command(zig)
            .args(["ar", "p"])
            .arg(library)
            .arg(member)
            .stdout(Stdio::from(output))
            .status()
            .map_err(|error| format!("launch pinned Zig ar extraction for {basename}: {error}"))?;
        if !status.success() {
            return Err(format!(
                "pinned Zig ar extraction for {basename} exited with {status}"
            ));
        }
        validate_file_shape(&raw_destination)?;
        if fs::metadata(&raw_destination)
            .map_err(|error| format!("inspect extracted object {basename}: {error}"))?
            .len()
            == 0
        {
            return Err(format!("pinned Zig ar extracted empty object {basename}"));
        }
        if let Some(objcopy) = objcopy {
            let destination = extracted.join(basename);
            // llvm-objcopy rewrites COFF symbol indices while stripping debug
            // data but does not rewrite the addrsig index table. The table is
            // only an optimization hint; keeping it would make the normalized
            // object invalid at the final LLD boundary.
            let status = hermetic_command(objcopy)
                .arg("--strip-debug")
                .arg("--remove-section=.llvm_addrsig")
                .arg(&raw_destination)
                .arg(&destination)
                .status()
                .map_err(|error| format!("launch pinned rust-objcopy for {basename}: {error}"))?;
            if !status.success() {
                return Err(format!(
                    "pinned rust-objcopy for {basename} exited with {status}"
                ));
            }
            validate_file_shape(&destination)?;
        }
    }

    let normalized = build_root.join(format!("{label}.normalized.archive"));
    if normalized.exists() {
        return Err(format!(
            "normalized archive destination already exists {}",
            normalized.display()
        ));
    }
    let mut create = hermetic_command(zig);
    create
        .current_dir(&extracted)
        .args(["ar", "crsD"])
        .arg(&normalized);
    for basename in sorted.keys() {
        create.arg(basename);
    }
    let status = create
        .status()
        .map_err(|error| format!("launch pinned Zig deterministic archiver: {error}"))?;
    if !status.success() {
        return Err(format!(
            "pinned Zig deterministic archiver exited with {status}"
        ));
    }
    let status = hermetic_command(zig)
        .args(["ranlib", "-D"])
        .arg(&normalized)
        .status()
        .map_err(|error| format!("launch pinned Zig deterministic ranlib: {error}"))?;
    if !status.success() {
        return Err(format!(
            "pinned Zig deterministic ranlib exited with {status}"
        ));
    }
    validate_file_shape(&normalized)?;

    let expected_names = sorted.keys().cloned().collect::<Vec<_>>();
    let normalized_names = archive_members(zig, &normalized)?;
    if normalized_names != expected_names {
        return Err("normalized archive member order or names changed".into());
    }
    for basename in &expected_names {
        let output = hermetic_command(zig)
            .args(["ar", "p"])
            .arg(&normalized)
            .arg(basename)
            .output()
            .map_err(|error| format!("re-read normalized object {basename}: {error}"))?;
        if !output.status.success() {
            return Err(format!(
                "re-read normalized object {basename} exited with {}",
                output.status
            ));
        }
        let extracted_hash = sha256_file(&extracted.join(basename))?;
        if sha256(&output.stdout) != extracted_hash {
            return Err(format!(
                "normalized archive object {basename} changed during repack"
            ));
        }
    }

    fs::copy(&normalized, library)
        .map_err(|error| format!("install normalized Ghostty archive: {error}"))?;
    if archive_members(zig, library)? != expected_names {
        return Err("installed Ghostty archive is not the normalized archive".into());
    }
    Ok(())
}

fn archive_members(zig: &Path, library: &Path) -> Result<Vec<String>, String> {
    let output = hermetic_command(zig)
        .args(["ar", "t"])
        .arg(library)
        .output()
        .map_err(|error| format!("launch pinned Zig archive listing: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "pinned Zig archive listing exited with {}",
            output.status
        ));
    }
    let text = std::str::from_utf8(&output.stdout)
        .map_err(|error| format!("pinned Zig archive listing is not UTF-8: {error}"))?;
    let members = text.lines().map(str::to_string).collect::<Vec<_>>();
    if members.iter().any(|member| member.is_empty()) {
        return Err("pinned Zig archive listing contained an empty member".into());
    }
    Ok(members)
}

fn validate_file_shape(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("inspect generated file {}: {error}", path.display()))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() == 0 {
        return Err(format!(
            "generated path is not one non-empty regular file {}",
            path.display()
        ));
    }
    Ok(())
}

fn hermetic_command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    command
        .env_clear()
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .env("TZ", "UTC")
        .env("SOURCE_DATE_EPOCH", "0")
        .env("ZERO_AR_DATE", "1")
        .env("HTTP_PROXY", "http://127.0.0.1:9")
        .env("HTTPS_PROXY", "http://127.0.0.1:9")
        .env("ALL_PROXY", "http://127.0.0.1:9")
        .env("http_proxy", "http://127.0.0.1:9")
        .env("https_proxy", "http://127.0.0.1:9")
        .env("all_proxy", "http://127.0.0.1:9")
        .env("NO_PROXY", "")
        .env("no_proxy", "");
    command
}

fn publish_bundle_noreplace(
    source_parent: &File,
    source_name: &OsStr,
    target_parent: &File,
    artifact_id: &str,
) -> io::Result<()> {
    validate_owned_directory_descriptor(source_parent)?;
    let source_name = path_component_cstring(source_name)?;
    let target_name = path_component_cstring(OsStr::new(artifact_id))?;
    #[cfg(target_os = "macos")]
    let result = unsafe {
        libc::renameatx_np(
            source_parent.as_raw_fd(),
            source_name.as_ptr(),
            target_parent.as_raw_fd(),
            target_name.as_ptr(),
            libc::RENAME_EXCL,
        )
    };
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            source_parent.as_raw_fd(),
            source_name.as_ptr(),
            target_parent.as_raw_fd(),
            target_name.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    return Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "atomic no-replace directory publication is unsupported on this build host",
    ));
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        if result == -1 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

struct PublicationTarget {
    recipe: File,
    target: File,
}

fn publication_target(
    output: &File,
    recipe_id: &str,
    target: &str,
) -> io::Result<PublicationTarget> {
    validate_owned_directory_descriptor(output)?;
    let recipe = create_or_open_directory_at(output, OsStr::new(recipe_id))?;
    let target = create_or_open_directory_at(&recipe, OsStr::new(target))?;
    Ok(PublicationTarget { recipe, target })
}

fn open_directory_nofollow(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
}

fn create_or_open_directory_at(parent: &File, name: &OsStr) -> io::Result<File> {
    let name = path_component_cstring(name)?;
    let result = unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) };
    if result == -1 {
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::AlreadyExists {
            return Err(error);
        }
    }
    open_directory_at_cstring(parent, &name)
}

fn open_directory_at(parent: &File, name: &OsStr) -> io::Result<File> {
    let name = path_component_cstring(name)?;
    open_directory_at_cstring(parent, &name)
}

fn open_directory_at_cstring(parent: &File, name: &CStr) -> io::Result<File> {
    let descriptor = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor == -1 {
        return Err(io::Error::last_os_error());
    }
    let directory = unsafe { File::from_raw_fd(descriptor) };
    validate_owned_directory_descriptor(&directory)?;
    Ok(directory)
}

fn validate_owned_directory_descriptor(directory: &File) -> io::Result<()> {
    let metadata = directory.metadata()?;
    if !metadata.is_dir()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.permissions().mode() & 0o022 != 0
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "directory is not owned by the effective user with group/world writes disabled",
        ));
    }
    Ok(())
}

fn validate_path_matches_directory(path: &Path, expected: &File) -> io::Result<()> {
    let actual = open_directory_nofollow(path)?;
    validate_owned_directory_descriptor(&actual)?;
    let actual_metadata = actual.metadata()?;
    let expected_metadata = expected.metadata()?;
    if actual_metadata.dev() != expected_metadata.dev()
        || actual_metadata.ino() != expected_metadata.ino()
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "path no longer names the validated directory generation",
        ));
    }
    Ok(())
}

fn path_component_cstring(component: &OsStr) -> io::Result<CString> {
    if Path::new(component).components().count() != 1
        || matches!(
            Path::new(component).components().next(),
            Some(Component::ParentDir | Component::CurDir | Component::RootDir)
        )
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "publication name is not one path component",
        ));
    }
    CString::new(component.as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))
}

fn extract_zig_toolchain(archive: &Path, destination: &Path) -> Result<PathBuf, String> {
    fs::create_dir(destination)
        .map_err(|error| format!("create isolated Zig toolchain root: {error}"))?;
    let status = hermetic_command("/usr/bin/tar")
        .args([OsStr::new("-xJf")])
        .arg(archive)
        .arg("-C")
        .arg(destination)
        .status()
        .map_err(|error| format!("launch system tar for reviewed Zig archive: {error}"))?;
    if !status.success() {
        return Err(format!("extract reviewed Zig archive exited with {status}"));
    }
    let mut roots = fs::read_dir(destination)
        .map_err(|error| format!("read extracted Zig root: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read extracted Zig entry: {error}"))?;
    if roots.len() != 1 {
        return Err("reviewed Zig archive did not contain exactly one root".into());
    }
    let root = roots.pop().expect("length checked");
    let metadata = root
        .file_type()
        .map_err(|error| format!("inspect extracted Zig root: {error}"))?;
    if !metadata.is_dir() || metadata.is_symlink() {
        return Err("reviewed Zig archive root is not one directory".into());
    }
    Ok(root.path().join("zig"))
}

fn recipe_text(target: &str) -> String {
    if target == WINDOWS_TARGET {
        return format!(
            "schema={WINDOWS_RECIPE_SCHEMA}\n\
target={target}\n\
zig_target={WINDOWS_ZIG_TARGET}\n\
ghostty_commit={GHOSTTY_COMMIT}\n\
ghostty_source_tree={GHOSTTY_SOURCE_TREE}\n\
ghostty_source_sha256={GHOSTTY_SOURCE_SHA256}\n\
ghostty_build_zig_sha256={GHOSTTY_BUILD_ZIG_SHA256}\n\
ghostty_build_overlay_sha256={BUILD_OVERLAY_SHA256}\n\
ghostty_build_flags={BUILD_FLAGS}\n\
archive_normalizer={WINDOWS_ARCHIVE_NORMALIZER}\n\
archive_member_count={ARCHIVE_MEMBER_COUNT}\n\
history_iterator_build_sha256={HISTORY_ITERATOR_BUILD_SHA256}\n\
history_iterator_source_sha256={HISTORY_ITERATOR_SOURCE_SHA256}\n\
history_iterator_archive_member_count={HISTORY_ITERATOR_ARCHIVE_MEMBER_COUNT}\n\
rust_objcopy_sha256={RUST_OBJCOPY_SHA256}\n\
build_environment={BUILD_ENVIRONMENT}\n\
input_staging={INPUT_STAGING}\n\
zig_version={ZIG_VERSION}\n\
zig_archive_sha256={ZIG_ARCHIVE_SHA256}\n\
zig_executable_sha256={ZIG_EXECUTABLE_SHA256}\n\
uucode_package={UUCODE_PACKAGE}\n\
uucode_archive_sha256={UUCODE_ARCHIVE_SHA256}\n\
highway_package={HIGHWAY_PACKAGE}\n\
highway_archive_sha256={HIGHWAY_ARCHIVE_SHA256}\n"
        );
    }
    format!(
        "schema={RECIPE_SCHEMA}\n\
target={target}\n\
ghostty_commit={GHOSTTY_COMMIT}\n\
ghostty_source_tree={GHOSTTY_SOURCE_TREE}\n\
ghostty_source_sha256={GHOSTTY_SOURCE_SHA256}\n\
ghostty_build_zig_sha256={GHOSTTY_BUILD_ZIG_SHA256}\n\
ghostty_build_overlay_sha256={BUILD_OVERLAY_SHA256}\n\
ghostty_build_flags={BUILD_FLAGS}\n\
archive_normalizer={ARCHIVE_NORMALIZER}\n\
archive_member_count={ARCHIVE_MEMBER_COUNT}\n\
build_environment={BUILD_ENVIRONMENT}\n\
input_staging={INPUT_STAGING}\n\
zig_version={ZIG_VERSION}\n\
zig_archive_sha256={ZIG_ARCHIVE_SHA256}\n\
zig_executable_sha256={ZIG_EXECUTABLE_SHA256}\n\
uucode_package={UUCODE_PACKAGE}\n\
uucode_archive_sha256={UUCODE_ARCHIVE_SHA256}\n\
highway_package={HIGHWAY_PACKAGE}\n\
highway_archive_sha256={HIGHWAY_ARCHIVE_SHA256}\n",
    )
}

fn receipt_text(
    target: &str,
    recipe_id: &str,
    artifact_id: &str,
    headers_sha256: &str,
    library_sha256: &str,
    history_iterator_sha256: Option<&str>,
) -> String {
    if target == WINDOWS_TARGET {
        let history_iterator_sha256 =
            history_iterator_sha256.expect("Windows v4 supply must include its history iterator");
        return format!(
            "schema={WINDOWS_RECEIPT_SCHEMA}\n\
target={target}\n\
zig_target={WINDOWS_ZIG_TARGET}\n\
recipe_id={recipe_id}\n\
artifact_id={artifact_id}\n\
ghostty_commit={GHOSTTY_COMMIT}\n\
ghostty_source_tree={GHOSTTY_SOURCE_TREE}\n\
ghostty_source_archive=provenance/ghostty-source.tar.gz\n\
ghostty_source_sha256={GHOSTTY_SOURCE_SHA256}\n\
ghostty_build_zig_sha256={GHOSTTY_BUILD_ZIG_SHA256}\n\
ghostty_build_overlay=provenance/libghostty-vt-build.zig\n\
ghostty_build_overlay_sha256={BUILD_OVERLAY_SHA256}\n\
ghostty_build_flags={BUILD_FLAGS}\n\
archive_normalizer={WINDOWS_ARCHIVE_NORMALIZER}\n\
archive_member_count={ARCHIVE_MEMBER_COUNT}\n\
history_iterator_build=provenance/ghostty-history-iterator-build.zig\n\
history_iterator_build_sha256={HISTORY_ITERATOR_BUILD_SHA256}\n\
history_iterator_source=provenance/ghostty-history-iterator.zig\n\
history_iterator_source_sha256={HISTORY_ITERATOR_SOURCE_SHA256}\n\
history_iterator_archive_member_count={HISTORY_ITERATOR_ARCHIVE_MEMBER_COUNT}\n\
rust_objcopy=provenance/rust-objcopy\n\
rust_objcopy_sha256={RUST_OBJCOPY_SHA256}\n\
build_environment={BUILD_ENVIRONMENT}\n\
input_staging={INPUT_STAGING}\n\
zig_version={ZIG_VERSION}\n\
zig_archive=provenance/zig.tar.xz\n\
zig_archive_sha256={ZIG_ARCHIVE_SHA256}\n\
zig_executable=provenance/zig\n\
zig_executable_sha256={ZIG_EXECUTABLE_SHA256}\n\
uucode_package={UUCODE_PACKAGE}\n\
uucode_archive=provenance/{UUCODE_PACKAGE}.tar.gz\n\
uucode_archive_sha256={UUCODE_ARCHIVE_SHA256}\n\
uucode_transport_sha256={UUCODE_TRANSPORT_SHA256}\n\
highway_package={HIGHWAY_PACKAGE}\n\
highway_archive=provenance/{HIGHWAY_PACKAGE}.tar.gz\n\
highway_archive_sha256={HIGHWAY_ARCHIVE_SHA256}\n\
highway_transport_sha256={HIGHWAY_TRANSPORT_SHA256}\n\
headers=include/ghostty\n\
headers_sha256={headers_sha256}\n\
library=lib/{WINDOWS_LIBRARY_NAME}\n\
library_sha256={library_sha256}\n\
history_iterator_library=lib/{WINDOWS_HISTORY_ITERATOR_LIBRARY_NAME}\n\
history_iterator_library_sha256={history_iterator_sha256}\n"
        );
    }
    assert!(
        history_iterator_sha256.is_none(),
        "v3 supply must not include a prebuilt history iterator"
    );
    format!(
        "schema={RECEIPT_SCHEMA}\n\
target={target}\n\
recipe_id={recipe_id}\n\
artifact_id={artifact_id}\n\
ghostty_commit={GHOSTTY_COMMIT}\n\
ghostty_source_tree={GHOSTTY_SOURCE_TREE}\n\
ghostty_source_archive=provenance/ghostty-source.tar.gz\n\
ghostty_source_sha256={GHOSTTY_SOURCE_SHA256}\n\
ghostty_build_zig_sha256={GHOSTTY_BUILD_ZIG_SHA256}\n\
ghostty_build_overlay=provenance/libghostty-vt-build.zig\n\
ghostty_build_overlay_sha256={BUILD_OVERLAY_SHA256}\n\
ghostty_build_flags={BUILD_FLAGS}\n\
archive_normalizer={ARCHIVE_NORMALIZER}\n\
archive_member_count={ARCHIVE_MEMBER_COUNT}\n\
build_environment={BUILD_ENVIRONMENT}\n\
input_staging={INPUT_STAGING}\n\
zig_version={ZIG_VERSION}\n\
zig_archive=provenance/zig.tar.xz\n\
zig_archive_sha256={ZIG_ARCHIVE_SHA256}\n\
zig_executable=provenance/zig\n\
zig_executable_sha256={ZIG_EXECUTABLE_SHA256}\n\
uucode_package={UUCODE_PACKAGE}\n\
uucode_archive=provenance/{UUCODE_PACKAGE}.tar.gz\n\
uucode_archive_sha256={UUCODE_ARCHIVE_SHA256}\n\
uucode_transport_sha256={UUCODE_TRANSPORT_SHA256}\n\
highway_package={HIGHWAY_PACKAGE}\n\
highway_archive=provenance/{HIGHWAY_PACKAGE}.tar.gz\n\
highway_archive_sha256={HIGHWAY_ARCHIVE_SHA256}\n\
highway_transport_sha256={HIGHWAY_TRANSPORT_SHA256}\n\
headers=include/ghostty\n\
headers_sha256={headers_sha256}\n\
library=lib/libghostty-vt.a\n\
library_sha256={library_sha256}\n",
    )
}

fn artifact_identity(
    recipe_id: &str,
    headers_sha256: &str,
    library_sha256: &str,
    history_iterator_sha256: Option<&str>,
) -> String {
    let identity = match history_iterator_sha256 {
        Some(history_iterator_sha256) => format!(
            "schema=hmux-ghostty-vt-artifact-id-v2\nrecipe_id={recipe_id}\nheaders_sha256={headers_sha256}\nlibrary_sha256={library_sha256}\nhistory_iterator_library_sha256={history_iterator_sha256}\n"
        ),
        None => format!(
            "schema=hmux-ghostty-vt-artifact-id-v1\nrecipe_id={recipe_id}\nheaders_sha256={headers_sha256}\nlibrary_sha256={library_sha256}\n"
        ),
    };
    sha256(identity.as_bytes())
}

fn run_zig(
    zig: &Path,
    source: &Path,
    global_cache: &Path,
    local_cache: &Path,
    install: &Path,
    target: &str,
) -> Result<(), String> {
    let status = hermetic_command(zig)
        .current_dir(source)
        .arg("build")
        .arg("--global-cache-dir")
        .arg(global_cache)
        .arg("--cache-dir")
        .arg(local_cache)
        .arg("--prefix")
        .arg(install)
        .arg(format!("-Dtarget={target}"))
        .args([
            "-Demit-lib-vt=true",
            "-Demit-xcframework=false",
            "-Dsimd=true",
            "-Doptimize=ReleaseFast",
            "-Dstrip=true",
            "-Dversion-string=1.3.2-dev",
        ])
        .status()
        .map_err(|error| format!("launch exact-pin Zig: {error}"))?;
    if !status.success() {
        return Err(format!("exact-pin Ghostty VT build exited with {status}"));
    }
    Ok(())
}

fn extract_source(archive: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir(destination).map_err(|error| format!("create isolated source root: {error}"))?;
    let file =
        File::open(archive).map_err(|error| format!("open Ghostty source archive: {error}"))?;
    let mut archive = Archive::new(GzDecoder::new(file));
    let mut archive_root: Option<OsString> = None;
    for entry in archive
        .entries()
        .map_err(|error| format!("read Ghostty source archive: {error}"))?
    {
        let mut entry = entry.map_err(|error| format!("read Ghostty source entry: {error}"))?;
        let kind = entry.header().entry_type().as_byte();
        if matches!(kind, b'g' | b'x' | b'L' | b'K') {
            continue;
        }
        let path = entry
            .path()
            .map_err(|error| format!("decode Ghostty source path: {error}"))?;
        let components = safe_components(&path)?;
        let Some((root, relative)) = components.split_first() else {
            continue;
        };
        match &archive_root {
            Some(expected) if expected != root => {
                return Err("Ghostty source archive has more than one top-level root".into());
            }
            None => archive_root = Some(root.clone()),
            _ => {}
        }
        if relative.is_empty() {
            continue;
        }
        let relative_path = relative.iter().collect::<PathBuf>();
        let output = destination.join(&relative_path);
        match kind {
            b'0' | 0 => {
                let parent = output
                    .parent()
                    .ok_or_else(|| "source entry has no parent".to_string())?;
                fs::create_dir_all(parent)
                    .map_err(|error| format!("create source directory: {error}"))?;
                let mut file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&output)
                    .map_err(|error| format!("create source file {}: {error}", output.display()))?;
                io::copy(&mut entry, &mut file).map_err(|error| {
                    format!("extract source file {}: {error}", output.display())
                })?;
            }
            b'5' => fs::create_dir_all(&output).map_err(|error| {
                format!("create source directory {}: {error}", output.display())
            })?,
            b'2' => {
                let link = entry
                    .link_name()
                    .map_err(|error| format!("decode source symlink: {error}"))?;
                if relative_path != Path::new("CLAUDE.md")
                    || link.as_deref() != Some(Path::new("AGENTS.md"))
                {
                    return Err(format!(
                        "Ghostty source archive contains unreviewed symlink {}",
                        relative_path.display()
                    ));
                }
            }
            _ => {
                return Err(format!(
                    "Ghostty source archive contains unsupported entry type {kind} at {}",
                    relative_path.display()
                ));
            }
        }
    }
    if archive_root.is_none() {
        return Err("Ghostty source archive is empty".into());
    }
    Ok(())
}

fn safe_components(path: &Path) -> Result<Vec<OsString>, String> {
    path.components()
        .map(|component| match component {
            Component::Normal(value) => Ok(value.to_os_string()),
            _ => Err(format!(
                "archive path is not relative and normalized: {}",
                path.display()
            )),
        })
        .collect()
}

fn validate_cache_closure(directory: &Path) -> Result<(), String> {
    let mut actual = fs::read_dir(directory)
        .map_err(|error| format!("read isolated Zig package cache: {error}"))?
        .map(|entry| {
            entry
                .map(|entry| entry.file_name())
                .map_err(|error| format!("read Zig package cache entry: {error}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    actual.sort();
    let mut expected = vec![
        OsString::from(format!("{HIGHWAY_PACKAGE}.tar.gz")),
        OsString::from(format!("{UUCODE_PACKAGE}.tar.gz")),
    ];
    expected.sort();
    if actual != expected {
        return Err("Zig package cache escaped the exact two-package closure".into());
    }
    Ok(())
}

fn ensure_existing_artifact(
    root_directory: &File,
    root: &Path,
    expected_receipt: &[u8],
    expected_headers: &str,
    expected_library: &str,
    expected_history_iterator: Option<&str>,
) -> Result<(), String> {
    let layout = if expected_history_iterator.is_some() {
        ArtifactLayout::WindowsV4
    } else {
        ArtifactLayout::UnixV3
    };
    validate_closed_bundle_shape_directory(root_directory, layout)?;
    let actual = read_regular_file_at(
        root_directory,
        OsStr::new(RECEIPT_NAME),
        expected_receipt.len(),
    )
    .map_err(|error| {
        format!(
            "read existing immutable receipt {}: {error}",
            root.display()
        )
    })?;
    if actual != expected_receipt {
        return Err(format!(
            "immutable artifact identity already exists with different receipt {}",
            root.display()
        ));
    }
    let include = open_directory_at(root_directory, OsStr::new("include"))
        .map_err(|error| format!("open immutable include directory: {error}"))?;
    let headers = open_directory_at(&include, OsStr::new("ghostty"))
        .map_err(|error| format!("open immutable header tree: {error}"))?;
    if sha256_tree_at(&headers)? != expected_headers {
        return Err("existing immutable artifact header tree was modified".into());
    }
    let library = open_directory_at(root_directory, OsStr::new("lib"))
        .map_err(|error| format!("open immutable library directory: {error}"))?;
    validate_regular_file_at(&library, layout.library_name(), expected_library)?;
    if let Some(expected) = expected_history_iterator {
        validate_regular_file_at(&library, WINDOWS_HISTORY_ITERATOR_LIBRARY_NAME, expected)?;
    }
    let provenance = open_directory_at(root_directory, OsStr::new("provenance"))
        .map_err(|error| format!("open immutable provenance directory: {error}"))?;
    validate_regular_file_at(&provenance, "ghostty-source.tar.gz", GHOSTTY_SOURCE_SHA256)?;
    validate_regular_file_at(&provenance, "zig.tar.xz", ZIG_ARCHIVE_SHA256)?;
    validate_regular_file_at(&provenance, "zig", ZIG_EXECUTABLE_SHA256)?;
    validate_regular_file_at(
        &provenance,
        &format!("{UUCODE_PACKAGE}.tar.gz"),
        UUCODE_ARCHIVE_SHA256,
    )?;
    validate_regular_file_at(
        &provenance,
        &format!("{HIGHWAY_PACKAGE}.tar.gz"),
        HIGHWAY_ARCHIVE_SHA256,
    )?;
    validate_regular_file_at(&provenance, "libghostty-vt-build.zig", BUILD_OVERLAY_SHA256)?;
    if layout == ArtifactLayout::WindowsV4 {
        validate_regular_file_at(
            &provenance,
            "ghostty-history-iterator-build.zig",
            HISTORY_ITERATOR_BUILD_SHA256,
        )?;
        validate_regular_file_at(
            &provenance,
            "ghostty-history-iterator.zig",
            HISTORY_ITERATOR_SOURCE_SHA256,
        )?;
        validate_regular_file_at(&provenance, "rust-objcopy", RUST_OBJCOPY_SHA256)?;
    }
    Ok(())
}

#[cfg(test)]
fn validate_closed_bundle_shape(root: &Path) -> Result<(), String> {
    let root = open_directory_nofollow(root)
        .map_err(|error| format!("open immutable bundle without aliases: {error}"))?;
    validate_closed_bundle_shape_directory(&root, ArtifactLayout::UnixV3)
}

fn validate_closed_bundle_shape_directory(
    root: &File,
    layout: ArtifactLayout,
) -> Result<(), String> {
    require_directory_entries(
        root,
        &[RECEIPT_NAME, "include", "lib", "provenance"],
        "bundle",
    )?;
    open_regular_file_at(root, OsStr::new(RECEIPT_NAME))
        .map_err(|error| format!("receipt is not one regular file: {error}"))?;

    let include = open_directory_at(root, OsStr::new("include"))
        .map_err(|error| format!("include is not one alias-free directory: {error}"))?;
    require_directory_entries(&include, &["ghostty"], "include")?;
    let headers = open_directory_at(&include, OsStr::new("ghostty"))
        .map_err(|error| format!("header root is not one alias-free directory: {error}"))?;
    sha256_tree_at(&headers)?;

    let library = open_directory_at(root, OsStr::new("lib"))
        .map_err(|error| format!("lib is not one alias-free directory: {error}"))?;
    let mut library_entries = vec![layout.library_name()];
    if layout == ArtifactLayout::WindowsV4 {
        library_entries.push(WINDOWS_HISTORY_ITERATOR_LIBRARY_NAME);
    }
    require_directory_entries(&library, &library_entries, "lib")?;
    open_regular_file_at(&library, OsStr::new(layout.library_name()))
        .map_err(|error| format!("library is not one regular file: {error}"))?;
    if layout == ArtifactLayout::WindowsV4 {
        open_regular_file_at(&library, OsStr::new(WINDOWS_HISTORY_ITERATOR_LIBRARY_NAME))
            .map_err(|error| format!("history iterator is not one regular file: {error}"))?;
    }

    let provenance = open_directory_at(root, OsStr::new("provenance"))
        .map_err(|error| format!("provenance is not one alias-free directory: {error}"))?;
    let uucode = format!("{UUCODE_PACKAGE}.tar.gz");
    let highway = format!("{HIGHWAY_PACKAGE}.tar.gz");
    let mut provenance_entries = vec![
        "ghostty-source.tar.gz",
        "libghostty-vt-build.zig",
        uucode.as_str(),
        highway.as_str(),
        "zig",
        "zig.tar.xz",
    ];
    if layout == ArtifactLayout::WindowsV4 {
        provenance_entries.extend([
            "ghostty-history-iterator-build.zig",
            "ghostty-history-iterator.zig",
            "rust-objcopy",
        ]);
    }
    require_directory_entries(&provenance, &provenance_entries, "provenance")?;
    for name in provenance_entries {
        open_regular_file_at(&provenance, OsStr::new(name))
            .map_err(|error| format!("provenance entry {name} is not regular: {error}"))?;
    }
    Ok(())
}

fn harden_bundle_permissions(root: &Path) -> Result<(), String> {
    fn harden(root: &Path, current: &Path) -> Result<(), String> {
        let metadata = fs::symlink_metadata(current)
            .map_err(|error| format!("inspect artifact bundle permissions: {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "artifact bundle contains an alias {}",
                current.display()
            ));
        }
        if metadata.is_dir() {
            for entry in fs::read_dir(current)
                .map_err(|error| format!("read artifact bundle permissions: {error}"))?
            {
                let entry = entry
                    .map_err(|error| format!("read artifact bundle permission entry: {error}"))?;
                harden(root, &entry.path())?;
            }
            fs::set_permissions(current, fs::Permissions::from_mode(0o755)).map_err(|error| {
                format!(
                    "make artifact bundle directory immutable {}: {error}",
                    current.display()
                )
            })?;
        } else if metadata.is_file() {
            let relative = current
                .strip_prefix(root)
                .map_err(|error| format!("resolve artifact bundle permission path: {error}"))?;
            let mode = if relative == Path::new("provenance/zig")
                || relative == Path::new("provenance/rust-objcopy")
            {
                0o755
            } else {
                0o644
            };
            fs::set_permissions(current, fs::Permissions::from_mode(mode)).map_err(|error| {
                format!(
                    "make artifact bundle file immutable {}: {error}",
                    current.display()
                )
            })?;
        } else {
            return Err(format!(
                "artifact bundle contains a special entry {}",
                current.display()
            ));
        }
        Ok(())
    }

    harden(root, root)
}

fn require_directory_entries(
    directory: &File,
    expected: &[&str],
    label: &str,
) -> Result<(), String> {
    let actual = directory_names(directory)
        .map_err(|error| format!("read immutable {label} directory: {error}"))?;
    let mut expected = expected
        .iter()
        .map(|name| OsString::from(*name))
        .collect::<Vec<_>>();
    expected.sort();
    if actual != expected {
        return Err(format!(
            "immutable {label} directory has an unexpected entry set"
        ));
    }
    Ok(())
}

fn directory_names(directory: &File) -> io::Result<Vec<OsString>> {
    let descriptor = unsafe { libc::dup(directory.as_raw_fd()) };
    if descriptor == -1 {
        return Err(io::Error::last_os_error());
    }
    let stream = unsafe { libc::fdopendir(descriptor) };
    if stream.is_null() {
        let error = io::Error::last_os_error();
        unsafe {
            libc::close(descriptor);
        }
        return Err(error);
    }
    let stream = DirectoryStream(stream);
    let mut names = Vec::new();
    loop {
        let mut entry = MaybeUninit::<libc::dirent>::uninit();
        let mut result = std::ptr::null_mut();
        let error = unsafe { libc::readdir_r(stream.0, entry.as_mut_ptr(), &mut result) };
        if error != 0 {
            return Err(io::Error::from_raw_os_error(error));
        }
        if result.is_null() {
            break;
        }
        let entry = unsafe { entry.assume_init() };
        let name = unsafe { CStr::from_ptr(entry.d_name.as_ptr()) }.to_bytes();
        if name != b"." && name != b".." {
            names.push(OsString::from_vec(name.to_vec()));
        }
    }
    names.sort();
    Ok(names)
}

struct DirectoryStream(*mut libc::DIR);

impl Drop for DirectoryStream {
    fn drop(&mut self) {
        unsafe {
            libc::closedir(self.0);
        }
    }
}

fn open_regular_file_at(parent: &File, name: &OsStr) -> io::Result<File> {
    let name = path_component_cstring(name)?;
    let descriptor = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor == -1 {
        return Err(io::Error::last_os_error());
    }
    let file = unsafe { File::from_raw_fd(descriptor) };
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.permissions().mode() & 0o022 != 0
        || metadata.nlink() != 1
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "entry is not one builder-owned immutable regular file",
        ));
    }
    Ok(file)
}

fn read_regular_file_at(parent: &File, name: &OsStr, maximum_bytes: usize) -> io::Result<Vec<u8>> {
    let mut file = open_regular_file_at(parent, name)?;
    let length = file.metadata()?.len();
    if length > maximum_bytes as u64 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "regular file exceeds its bounded read",
        ));
    }
    let mut bytes = Vec::with_capacity(length as usize);
    file.by_ref()
        .take(maximum_bytes as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > maximum_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "regular file grew beyond its bounded read",
        ));
    }
    Ok(bytes)
}

fn validate_regular_file_at(parent: &File, name: &str, expected: &str) -> Result<(), String> {
    let file = open_regular_file_at(parent, OsStr::new(name))
        .map_err(|error| format!("read immutable file {name}: {error}"))?;
    let actual =
        sha256_open_file(file).map_err(|error| format!("hash immutable file {name}: {error}"))?;
    if actual != expected {
        return Err(format!(
            "immutable file {name} SHA-256 {actual} does not match {expected}"
        ));
    }
    Ok(())
}

fn sha256_tree_at(root: &File) -> Result<String, String> {
    let mut files = Vec::new();
    collect_regular_files_at(root, "", &mut files)?;
    files.sort_by(|left, right| left.0.cmp(&right.0));
    let mut digest = Sha256::new();
    for (relative, mut file, length) in files {
        digest.update(relative.as_bytes());
        digest.update([0]);
        digest.update(length.to_le_bytes());
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let count = file
                .read(&mut buffer)
                .map_err(|error| format!("read immutable tree file {relative}: {error}"))?;
            if count == 0 {
                break;
            }
            digest.update(&buffer[..count]);
        }
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn collect_regular_files_at(
    directory: &File,
    prefix: &str,
    files: &mut Vec<(String, File, u64)>,
) -> Result<(), String> {
    for name in directory_names(directory)
        .map_err(|error| format!("read immutable tree directory: {error}"))?
    {
        let name_string = name.to_string_lossy();
        let relative = if prefix.is_empty() {
            name_string.into_owned()
        } else {
            format!("{prefix}/{name_string}")
        };
        let kind = entry_kind_at(directory, &name)
            .map_err(|error| format!("inspect immutable tree entry {relative}: {error}"))?;
        if kind == libc::S_IFDIR {
            let child = open_directory_at(directory, &name)
                .map_err(|error| format!("open immutable tree directory {relative}: {error}"))?;
            collect_regular_files_at(&child, &relative, files)?;
        } else if kind == libc::S_IFREG {
            let file = open_regular_file_at(directory, &name)
                .map_err(|error| format!("read immutable tree file {relative}: {error}"))?;
            let length = file
                .metadata()
                .map_err(|error| format!("inspect immutable tree file {relative}: {error}"))?
                .len();
            files.push((relative, file, length));
        } else {
            return Err(format!(
                "immutable tree contains a symlink or special entry {relative}"
            ));
        }
    }
    Ok(())
}

fn sha256_open_file(mut file: File) -> io::Result<String> {
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn entry_kind_at(parent: &File, name: &OsStr) -> io::Result<libc::mode_t> {
    let name = path_component_cstring(name)?;
    let mut metadata = MaybeUninit::<libc::stat>::uninit();
    let result = unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            name.as_ptr(),
            metadata.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result == -1 {
        return Err(io::Error::last_os_error());
    }
    let metadata = unsafe { metadata.assume_init() };
    Ok(metadata.st_mode & libc::S_IFMT)
}

fn validate_file(path: &Path, expected: &str) -> Result<(), String> {
    let actual = sha256_file(path)?;
    if actual != expected {
        return Err(format!(
            "artifact SHA-256 {actual} does not match reviewed {expected}: {}",
            path.display()
        ));
    }
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("inspect regular file {}: {error}", path.display()))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(format!("input is not one regular file {}", path.display()));
    }
    let mut file = File::open(path).map_err(|error| format!("open {}: {error}", path.display()))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("read {}: {error}", path.display()))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn sha256_tree(root: &Path) -> Result<String, String> {
    ensure_regular_directory(root)?;
    let mut files = Vec::new();
    collect_regular_files(root, root, &mut files)?;
    files.sort_by(|left, right| left.0.cmp(&right.0));
    let mut digest = Sha256::new();
    for (relative, path) in files {
        let bytes = fs::read(&path)
            .map_err(|error| format!("read tree entry {}: {error}", path.display()))?;
        digest.update(relative.as_bytes());
        digest.update([0]);
        digest.update((bytes.len() as u64).to_le_bytes());
        digest.update(bytes);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn collect_regular_files(
    root: &Path,
    directory: &Path,
    files: &mut Vec<(String, PathBuf)>,
) -> Result<(), String> {
    let mut entries = fs::read_dir(directory)
        .map_err(|error| format!("read directory {}: {error}", directory.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read directory entry: {error}"))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let file_type = entry
            .file_type()
            .map_err(|error| format!("read type for {}: {error}", entry.path().display()))?;
        if file_type.is_symlink() {
            return Err(format!("tree contains symlink {}", entry.path().display()));
        }
        if file_type.is_dir() {
            collect_regular_files(root, &entry.path(), files)?;
        } else if file_type.is_file() {
            let relative = entry
                .path()
                .strip_prefix(root)
                .map_err(|error| format!("resolve tree path: {error}"))?
                .to_string_lossy()
                .replace('\\', "/");
            files.push((relative, entry.path()));
        } else {
            return Err(format!(
                "tree contains special file {}",
                entry.path().display()
            ));
        }
    }
    Ok(())
}

fn copy_regular_tree(source: &Path, destination: &Path) -> Result<(), String> {
    ensure_regular_directory(source)?;
    fs::create_dir(destination).map_err(|error| {
        format!(
            "create destination directory {}: {error}",
            destination.display()
        )
    })?;
    let mut entries = fs::read_dir(source)
        .map_err(|error| format!("read source directory {}: {error}", source.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("read source directory entry: {error}"))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let file_type = entry
            .file_type()
            .map_err(|error| format!("read type for {}: {error}", entry.path().display()))?;
        let output = destination.join(entry.file_name());
        if file_type.is_symlink() {
            return Err(format!(
                "source closure contains symlink {}",
                entry.path().display()
            ));
        }
        if file_type.is_dir() {
            copy_regular_tree(&entry.path(), &output)?;
        } else if file_type.is_file() {
            copy_regular_file(&entry.path(), &output)?;
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
        .map_err(|error| format!("inspect source file {}: {error}", source.display()))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(format!(
            "source is not one regular file {}",
            source.display()
        ));
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("create copy destination: {error}"))?;
    }
    fs::copy(source, destination).map_err(|error| {
        format!(
            "copy {} to {}: {error}",
            source.display(),
            destination.display()
        )
    })?;
    Ok(())
}

fn ensure_regular_directory(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("inspect directory {}: {error}", path.display()))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(format!(
            "path is not one regular directory {}",
            path.display()
        ));
    }
    Ok(())
}

fn prepare_output_directory(requested: &Path) -> Result<(PathBuf, File), String> {
    match fs::symlink_metadata(requested) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err(format!(
                    "artifact output must not be a symlink {}",
                    requested.display()
                ));
            }
            let canonical = requested
                .canonicalize()
                .map_err(|error| format!("canonicalize artifact output: {error}"))?;
            let directory = validate_output_directory(&canonical)?;
            Ok((canonical, directory))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let requested_parent = requested.parent().unwrap_or_else(|| Path::new("."));
            let name = requested.file_name().ok_or_else(|| {
                format!(
                    "artifact output has no creatable final component {}",
                    requested.display()
                )
            })?;
            let parent = requested_parent
                .canonicalize()
                .map_err(|error| format!("canonicalize artifact output parent: {error}"))?;
            let parent_directory = validate_output_directory(&parent)?;
            let name_string = path_component_cstring(name)
                .map_err(|error| format!("validate artifact output component: {error}"))?;
            let created =
                unsafe { libc::mkdirat(parent_directory.as_raw_fd(), name_string.as_ptr(), 0o700) };
            if created == -1 {
                return Err(format!(
                    "create owner-controlled artifact output: {}",
                    io::Error::last_os_error()
                ));
            }
            let canonical = parent.join(name);
            let directory = open_directory_at_cstring(&parent_directory, &name_string)
                .map_err(|error| format!("open created artifact output: {error}"))?;
            validate_owned_directory_descriptor(&directory)
                .map_err(|error| format!("validate created artifact output: {error}"))?;
            validate_path_matches_directory(&canonical, &directory)
                .map_err(|error| format!("validate created artifact output generation: {error}"))?;
            Ok((canonical, directory))
        }
        Err(error) => Err(format!(
            "inspect artifact output {}: {error}",
            requested.display()
        )),
    }
}

fn validate_output_directory(path: &Path) -> Result<File, String> {
    if !path.is_absolute() {
        return Err(format!(
            "artifact output is not an absolute canonical path {}",
            path.display()
        ));
    }
    let ancestors = path.ancestors().collect::<Vec<_>>();
    let mut metadata = Vec::with_capacity(ancestors.len());
    for ancestor in &ancestors {
        let inspected = fs::symlink_metadata(ancestor).map_err(|error| {
            format!(
                "inspect artifact output ancestor {}: {error}",
                ancestor.display()
            )
        })?;
        if !inspected.is_dir() || inspected.file_type().is_symlink() {
            return Err(format!(
                "artifact output ancestor is not one directory {}",
                ancestor.display()
            ));
        }
        metadata.push(inspected);
    }

    let effective_user = unsafe { libc::geteuid() };
    for (index, (ancestor, inspected)) in ancestors.iter().zip(&metadata).enumerate() {
        let writable_by_others = inspected.permissions().mode() & 0o022 != 0;
        let owned_by_builder = inspected.uid() == effective_user;
        let owned_by_root = inspected.uid() == 0;
        let protected_sticky_parent = owned_by_root
            && inspected.permissions().mode() & 0o1000 != 0
            && writable_by_others
            && index > 0
            && metadata[index - 1].uid() == effective_user
            && metadata[index - 1].permissions().mode() & 0o022 == 0;
        if (!owned_by_builder && !owned_by_root) || (writable_by_others && !protected_sticky_parent)
        {
            return Err(format!(
                "artifact output ancestor is not trusted against replacement {}",
                ancestor.display()
            ));
        }
    }

    let output = open_directory_nofollow(path)
        .map_err(|error| format!("open artifact output without aliases: {error}"))?;
    validate_owned_directory_descriptor(&output)
        .map_err(|error| format!("validate artifact output ownership: {error}"))?;
    validate_path_matches_directory(path, &output)
        .map_err(|error| format!("validate artifact output generation: {error}"))?;
    Ok(output)
}

fn ensure_owner_only_directory(path: &Path) -> Result<(), String> {
    ensure_regular_directory(path)?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("inspect owned directory {}: {error}", path.display()))?;
    if metadata.uid() != unsafe { libc::geteuid() } || metadata.permissions().mode() & 0o077 != 0 {
        return Err(format!(
            "build staging directory is not owner-only {}",
            path.display()
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = fs::metadata(path)
        .map_err(|error| format!("inspect copied Zig executable: {error}"))?
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions)
        .map_err(|error| format!("make copied Zig executable runnable: {error}"))
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> Result<(), String> {
    Err("Ghostty supply staging currently requires a Unix build host".into())
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recipe_identity_changes_with_the_target_only() {
        let arm = sha256(recipe_text("aarch64-apple-darwin").as_bytes());
        let intel = sha256(recipe_text("x86_64-apple-darwin").as_bytes());
        assert_ne!(arm, intel);
        assert_eq!(arm, sha256(recipe_text("aarch64-apple-darwin").as_bytes()));
    }

    #[test]
    fn windows_recipe_identity_is_reviewed_and_stable() {
        assert_eq!(
            sha256(recipe_text(WINDOWS_TARGET).as_bytes()),
            "3be79c8512bfecbecfe2850b7ee872f2cd4c79ef3c06c915bd7d4babe91a58f1"
        );
    }

    #[test]
    fn options_are_closed_and_complete() {
        let error = parse_options([
            OsString::from("stage-ghostty-vt"),
            OsString::from("--unknown"),
            OsString::from("value"),
        ])
        .unwrap_err();
        assert!(error.contains("required option --ghostty-source"));
    }

    #[test]
    fn immutable_publication_never_replaces_an_existing_identity() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("target");
        let first_parent = root.path().join("first");
        let second_parent = root.path().join("second");
        fs::create_dir(&target).unwrap();
        fs::create_dir(&first_parent).unwrap();
        fs::create_dir(&second_parent).unwrap();
        let first = first_parent.join("bundle");
        let second = second_parent.join("bundle");
        fs::create_dir(&first).unwrap();
        fs::create_dir(&second).unwrap();
        fs::write(first.join("identity"), b"first").unwrap();
        fs::write(second.join("identity"), b"second").unwrap();
        let target_directory = open_directory_nofollow(&target).unwrap();
        let first_parent = open_directory_nofollow(&first_parent).unwrap();
        let second_parent = open_directory_nofollow(&second_parent).unwrap();

        publish_bundle_noreplace(
            &first_parent,
            OsStr::new("bundle"),
            &target_directory,
            "artifact",
        )
        .unwrap();
        let error = publish_bundle_noreplace(
            &second_parent,
            OsStr::new("bundle"),
            &target_directory,
            "artifact",
        )
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(
            fs::read(target.join("artifact/identity")).unwrap(),
            b"first"
        );
        assert_eq!(fs::read(second.join("identity")).unwrap(), b"second");
    }

    #[cfg(unix)]
    #[test]
    fn immutable_publication_uses_held_source_and_target_generations() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let source_path = root.path().join("source");
        let displaced_source = root.path().join("displaced-source");
        let target_path = root.path().join("target");
        let displaced_target = root.path().join("displaced-target");
        let outside = root.path().join("outside");
        fs::create_dir(&source_path).unwrap();
        fs::create_dir(source_path.join("bundle")).unwrap();
        fs::write(source_path.join("bundle/identity"), b"held").unwrap();
        fs::create_dir(&target_path).unwrap();
        fs::create_dir(&outside).unwrap();
        let source = open_directory_nofollow(&source_path).unwrap();
        let target = open_directory_nofollow(&target_path).unwrap();

        fs::rename(&source_path, &displaced_source).unwrap();
        fs::create_dir(&source_path).unwrap();
        fs::create_dir(source_path.join("bundle")).unwrap();
        fs::write(source_path.join("bundle/identity"), b"replacement").unwrap();
        fs::rename(&target_path, &displaced_target).unwrap();
        symlink(&outside, &target_path).unwrap();

        publish_bundle_noreplace(&source, OsStr::new("bundle"), &target, "artifact").unwrap();

        assert_eq!(
            fs::read(displaced_target.join("artifact/identity")).unwrap(),
            b"held"
        );
        assert_eq!(
            fs::read(source_path.join("bundle/identity")).unwrap(),
            b"replacement"
        );
        assert!(!outside.join("artifact").exists());
    }

    #[cfg(unix)]
    #[test]
    fn immutable_publication_does_not_follow_a_symlinked_target() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let output = root.path().join("output");
        let outside = root.path().join("outside");
        fs::create_dir(&output).unwrap();
        fs::create_dir(&outside).unwrap();
        symlink(&outside, output.join("recipe")).unwrap();
        let output = open_directory_nofollow(&output).unwrap();

        assert!(publication_target(&output, "recipe", "target").is_err());
        assert!(!outside.join("target").exists());
    }

    #[test]
    fn artifact_output_rejects_group_or_world_writable_ownership_boundaries() {
        let root = tempfile::tempdir().unwrap();
        let writable_ancestor = root.path().join("writable-ancestor");
        let output = writable_ancestor.join("output");
        fs::create_dir(&writable_ancestor).unwrap();
        fs::create_dir(&output).unwrap();
        fs::set_permissions(&writable_ancestor, fs::Permissions::from_mode(0o770)).unwrap();

        let output = output.canonicalize().unwrap();
        let writable_ancestor = writable_ancestor.canonicalize().unwrap();
        let error = validate_output_directory(&output).unwrap_err();
        assert!(error.contains("not trusted against replacement"));

        fs::set_permissions(&writable_ancestor, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&output, fs::Permissions::from_mode(0o707)).unwrap();
        let error = validate_output_directory(&output).unwrap_err();
        assert!(error.contains("not trusted against replacement"));
    }

    #[test]
    fn missing_output_is_created_owner_only_beneath_a_validated_parent() {
        let root = tempfile::tempdir().unwrap();
        let output = root.path().join("created-output");

        let (canonical, descriptor) = prepare_output_directory(&output).unwrap();

        assert_eq!(canonical, output.canonicalize().unwrap());
        validate_path_matches_directory(&canonical, &descriptor).unwrap();
        assert_eq!(
            descriptor.metadata().unwrap().permissions().mode() & 0o777,
            0o700
        );
    }

    #[test]
    fn publication_rejects_writable_existing_recipe_directories() {
        let root = tempfile::tempdir().unwrap();
        let output = root.path().join("output");
        let recipe = output.join("recipe");
        fs::create_dir(&output).unwrap();
        fs::create_dir(&recipe).unwrap();
        fs::set_permissions(&recipe, fs::Permissions::from_mode(0o770)).unwrap();
        let output = validate_output_directory(&output.canonicalize().unwrap()).unwrap();

        assert!(publication_target(&output, "recipe", "target").is_err());
        assert!(!recipe.join("target").exists());
    }

    #[test]
    fn validated_directory_descriptor_detects_path_rebinding() {
        let root = tempfile::tempdir().unwrap();
        let output_path = root.path().join("output");
        fs::create_dir(&output_path).unwrap();
        let output = validate_output_directory(&output_path.canonicalize().unwrap()).unwrap();
        let publication = publication_target(&output, "recipe", "target").unwrap();
        let target_path = output_path.join("recipe/target");
        let displaced = output_path.join("recipe/displaced-target");

        fs::rename(&target_path, &displaced).unwrap();
        fs::create_dir(&target_path).unwrap();

        let error = validate_path_matches_directory(&target_path, &publication.target).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn immutable_bundle_shape_is_closed_and_alias_free() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("include/ghostty")).unwrap();
        fs::create_dir(root.path().join("lib")).unwrap();
        fs::create_dir(root.path().join("provenance")).unwrap();
        fs::write(root.path().join(RECEIPT_NAME), b"receipt").unwrap();
        fs::write(root.path().join("unexpected"), b"not in the bundle schema").unwrap();

        assert!(validate_closed_bundle_shape(root.path()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn immutable_bundle_shape_rejects_an_intermediate_alias() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let bundle = root.path().join("bundle");
        let outside_library = root.path().join("outside-library");
        fs::create_dir_all(bundle.join("include/ghostty")).unwrap();
        fs::create_dir(bundle.join("provenance")).unwrap();
        fs::create_dir(&outside_library).unwrap();
        fs::write(outside_library.join("libghostty-vt.a"), b"library").unwrap();
        fs::write(bundle.join(RECEIPT_NAME), b"receipt").unwrap();
        symlink(&outside_library, bundle.join("lib")).unwrap();

        assert!(validate_closed_bundle_shape(&bundle).is_err());
    }

    #[test]
    fn immutable_bundle_shape_rejects_a_writable_nested_directory() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("include")).unwrap();
        fs::create_dir(root.path().join("lib")).unwrap();
        fs::create_dir(root.path().join("provenance")).unwrap();
        fs::write(root.path().join(RECEIPT_NAME), b"receipt").unwrap();
        fs::set_permissions(
            root.path().join("include"),
            fs::Permissions::from_mode(0o777),
        )
        .unwrap();

        assert!(validate_closed_bundle_shape(root.path()).is_err());
    }

    #[test]
    fn descriptor_tree_hash_matches_the_packaged_tree_identity() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("nested/deeper")).unwrap();
        fs::create_dir(root.path().join("prefix")).unwrap();
        fs::write(root.path().join("a.h"), b"a").unwrap();
        fs::write(root.path().join("nested/b.h"), b"bb").unwrap();
        fs::write(root.path().join("nested/deeper/c.h"), b"ccc").unwrap();
        fs::write(root.path().join("prefix.h"), b"prefix file").unwrap();
        fs::write(root.path().join("prefix/child.h"), b"prefix child").unwrap();

        let directory = open_directory_nofollow(root.path()).unwrap();
        assert_eq!(
            sha256_tree_at(&directory).unwrap(),
            sha256_tree(root.path()).unwrap()
        );
    }
}
