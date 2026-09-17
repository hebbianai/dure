use crate::ghostty_proof_receipt;
use std::env;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const UUCODE_PACKAGE: &str = "uucode-0.2.0-ZZjBPlK5VADj7fdoq7G8LIHzD5o6FSkcBXXrRWr4jnrA.tar.gz";
const HIGHWAY_PACKAGE: &str = "N-V-__8AAGmZhABbsPJLfbqrh6JTHsXhY6qCaLAQyx25e0XE.tar.gz";

pub(crate) fn build_history_iterator(
    artifacts: &ghostty_proof_receipt::StagedArtifacts,
    target: &str,
    out_dir: &Path,
) -> PathBuf {
    let zig_target = match target {
        "aarch64-apple-darwin" => "aarch64-macos",
        "x86_64-apple-darwin" => "x86_64-macos",
        "aarch64-unknown-linux-musl" => "aarch64-linux-musl",
        "x86_64-unknown-linux-musl" => "x86_64-linux-musl",
        other => panic!("unsupported exact-pin Hmux iterator target {other}"),
    };
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let iterator_source = manifest.join("src/ghostty_history_iterator.zig");
    let build_source = manifest.join("src/ghostty_history_iterator_build.zig");
    println!("cargo:rerun-if-changed={}", iterator_source.display());
    println!("cargo:rerun-if-changed={}", build_source.display());

    // Cargo owns OUT_DIR and build exclusion. Only this invocation owns scratch;
    // retain the link input separately so retries cannot delete an earlier one.
    let scratch = tempfile::Builder::new()
        .prefix("hmux-ghostty-history-iterator-")
        .suffix(".noindex")
        .tempdir_in(out_dir)
        .unwrap_or_else(|error| panic!("create owned iterator preparation: {error}"));
    let root = scratch.path();
    let install = root.join("install");
    let library = install.join("lib/libhmux-ghostty-history-iterator.a");
    let source = root.join("source");
    let global_cache = root.join("zig-global-cache");
    let local_cache = root.join("zig-local-cache");
    fs::create_dir_all(&source)
        .and_then(|_| fs::create_dir_all(global_cache.join("p")))
        .and_then(|_| fs::create_dir_all(&local_cache))
        .and_then(|_| fs::create_dir_all(&install))
        .unwrap_or_else(|error| panic!("create generated iterator build roots: {error}"));

    let extract = hermetic_command("/usr/bin/tar")
        .args(["-xzf"])
        .arg(&artifacts.source_archive)
        .args(["-C"])
        .arg(&source)
        .arg("--strip-components=1")
        .status()
        .unwrap_or_else(|error| panic!("launch exact-pin source extraction: {error}"));
    if !extract.success() {
        panic!("exact-pin source extraction exited with {extract}");
    }
    fs::copy(&build_source, source.join("build.zig"))
        .unwrap_or_else(|error| panic!("install Hmux iterator build overlay: {error}"));
    fs::copy(&iterator_source, source.join("hmux_history_iterator.zig"))
        .unwrap_or_else(|error| panic!("install Hmux iterator source: {error}"));
    expose_pinned_terminal_internals(&source);
    fs::copy(
        &artifacts.uucode_archive,
        global_cache.join("p").join(UUCODE_PACKAGE),
    )
    .unwrap_or_else(|error| panic!("stage exact-pin uucode package: {error}"));
    if let Some(highway) = artifacts.highway_archive.as_ref() {
        fs::copy(highway, global_cache.join("p").join(HIGHWAY_PACKAGE))
            .unwrap_or_else(|error| panic!("stage exact-pin highway package: {error}"));
    }

    let zig_toolchain = root.join("zig-toolchain");
    fs::create_dir(&zig_toolchain)
        .unwrap_or_else(|error| panic!("create exact-pin Zig toolchain root: {error}"));
    let extract_zig = hermetic_command("/usr/bin/tar")
        .args(["-xJf"])
        .arg(&artifacts.zig_archive)
        .args(["-C"])
        .arg(&zig_toolchain)
        .status()
        .unwrap_or_else(|error| panic!("launch exact-pin Zig extraction: {error}"));
    if !extract_zig.success() {
        panic!("exact-pin Zig extraction exited with {extract_zig}");
    }
    let mut zig_roots = fs::read_dir(&zig_toolchain)
        .unwrap_or_else(|error| panic!("read exact-pin Zig root: {error}"))
        .collect::<Result<Vec<_>, _>>()
        .unwrap_or_else(|error| panic!("read exact-pin Zig entry: {error}"));
    if zig_roots.len() != 1 {
        panic!("exact-pin Zig archive must contain one root");
    }
    let zig = zig_roots.pop().unwrap().path().join("zig");

    let status = hermetic_command(&zig)
        .current_dir(&source)
        .arg("build")
        .arg("--global-cache-dir")
        .arg(&global_cache)
        .arg("--cache-dir")
        .arg(&local_cache)
        .arg("--prefix")
        .arg(&install)
        .arg(format!("-Dtarget={zig_target}"))
        .args([
            "-Demit-lib-vt=true",
            "-Demit-xcframework=false",
            "-Dsimd=true",
            "-Doptimize=ReleaseFast",
            "-Dstrip=true",
            "-Dversion-string=1.3.2-dev",
        ])
        .status()
        .unwrap_or_else(|error| panic!("launch exact-pin Hmux iterator build: {error}"));
    if !status.success() {
        panic!("exact-pin Hmux iterator build exited with {status}");
    }
    if !fs::symlink_metadata(&library)
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
    {
        panic!(
            "exact-pin Hmux iterator build did not produce {}",
            library.display()
        );
    }
    let retained = out_dir.join("libhmux-ghostty-history-iterator.a");
    fs::rename(&library, &retained)
        .unwrap_or_else(|error| panic!("retain completed iterator archive: {error}"));
    scratch
        .close()
        .unwrap_or_else(|error| panic!("retire iterator preparation: {error}"));
    retained
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

fn expose_pinned_terminal_internals(source: &Path) {
    let lib_vt = source.join("src/lib_vt.zig");
    let contents = fs::read_to_string(&lib_vt)
        .unwrap_or_else(|error| panic!("read exact-pin Zig module: {error}"));
    let declaration = "const terminal = @import(\"terminal/main.zig\");";
    if contents.matches(declaration).count() != 1 {
        panic!("exact-pin Zig module terminal declaration changed");
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
        .unwrap_or_else(|error| panic!("install exact-pin Hmux internal seam: {error}"));
}

#[cfg(all(test, unix))]
#[path = "history_iterator_build_tests.rs"]
mod tests;
