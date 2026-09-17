mod ghostty_proof_receipt;
mod history_iterator_build;

use history_iterator_build::build_history_iterator;

use std::env;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-env-changed=HMUX_GHOSTTY_VT_PROOF_PREFIX");
    if env::var_os("CARGO_FEATURE_EXTERNAL_PROOF").is_none() {
        return;
    }

    let target = env::var("TARGET").expect("Cargo must provide TARGET");
    let prefix = env::var_os("HMUX_GHOSTTY_VT_PROOF_PREFIX")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            panic!(
                "external-proof requires HMUX_GHOSTTY_VT_PROOF_PREFIX; the build never downloads or builds Ghostty"
            )
        });
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo must provide OUT_DIR"));
    let artifacts = ghostty_proof_receipt::validate_and_stage(&prefix, &target, &out_dir)
        .unwrap_or_else(|error| panic!("invalid exact-pin Ghostty proof receipt: {error}"));
    for path in &artifacts.watched_paths {
        println!("cargo:rerun-if-changed={}", path.display());
    }

    let shim = PathBuf::from("src/ghostty_core_proof_shim.c");
    println!("cargo:rerun-if-changed={}", shim.display());
    cc::Build::new()
        .file(&shim)
        .include(&artifacts.include_dir)
        .define("GHOSTTY_STATIC", None)
        .flag_if_supported("-std=c11")
        .warnings(true)
        .compile("hmux_ghostty_core_proof_shim");

    let (iterator_library, iterator_library_name) = match (
        artifacts.history_iterator_library.as_ref(),
        artifacts.history_iterator_library_name.as_ref(),
    ) {
        (Some(library), Some(name)) => (library.clone(), name.clone()),
        (None, None) => (
            build_history_iterator(&artifacts, &target, &out_dir),
            "hmux-ghostty-history-iterator".to_string(),
        ),
        _ => panic!("validated history iterator path and link name must be present together"),
    };
    let iterator_dir = iterator_library
        .parent()
        .expect("built history iterator archive has a parent");
    println!("cargo:rustc-link-search=native={}", iterator_dir.display());
    println!("cargo:rustc-link-lib=static={iterator_library_name}");

    let library_dir = artifacts
        .library
        .parent()
        .expect("validated Ghostty archive has a parent");
    println!("cargo:rustc-link-search=native={}", library_dir.display());
    println!("cargo:rustc-link-lib=static={}", artifacts.library_name);
}
