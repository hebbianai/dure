use std::process::Command;

fn git_output(args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn safe_build_id(value: &str) -> bool {
    value.len() <= 128
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'+' | b'-'))
}

fn safe_source_commit(value: &str) -> bool {
    value == "unknown"
        || (value.len() == 40
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
}

fn rerun_if_sources_change() {
    for path in [
        "src",
        "Cargo.toml",
        "../hmux-cli/src",
        "../hmux-cli/Cargo.toml",
        "../hmux-client/src",
        "../hmux-client/Cargo.toml",
        "../hmux-host/src",
        "../hmux-host/Cargo.toml",
        "../hmux-runtime/src",
        "../hmux-runtime/Cargo.toml",
        "../hmux-runtime-contract/src",
        "../hmux-runtime-contract/Cargo.toml",
        "../../../crates/hebbian-process-sampler/src",
        "../../../crates/hebbian-process-sampler/Cargo.toml",
        "../../Cargo.toml",
        "../../Cargo.lock",
        "../../build-support/build_id.rs",
    ] {
        println!("cargo:rerun-if-changed={path}");
    }
    for git_path in ["HEAD", "index", "packed-refs"] {
        if let Some(path) = git_output(&["rev-parse", "--git-path", git_path]) {
            println!("cargo:rerun-if-changed={path}");
        }
    }
    if let Some(reference) = git_output(&["symbolic-ref", "-q", "HEAD"]) {
        if let Some(path) = git_output(&["rev-parse", "--git-path", &reference]) {
            println!("cargo:rerun-if-changed={path}");
        }
    }
}

pub fn emit_build_id() {
    println!("cargo:rerun-if-env-changed=HMUX_BUILD_ID");
    println!("cargo:rerun-if-env-changed=HMUX_SOURCE_COMMIT");
    let explicit_build_id = std::env::var("HMUX_BUILD_ID")
        .ok()
        .filter(|value| !value.is_empty());
    if explicit_build_id.is_none() {
        rerun_if_sources_change();
    }
    let build_id = explicit_build_id.unwrap_or_else(|| {
        let version = env!("CARGO_PKG_VERSION");
        let revision = git_output(&["rev-parse", "--short=12", "HEAD"])
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "unknown".to_string());
        let dirty = git_output(&[
            "status",
            "--porcelain",
            "--untracked-files=normal",
            "--",
            "../..",
            "../../../crates/hebbian-process-sampler",
        ])
        .is_some_and(|value| !value.is_empty());
        format!("{version}+{revision}{}", if dirty { "-dirty" } else { "" })
    });
    assert!(
        safe_build_id(&build_id),
        "HMUX_BUILD_ID must be one safe path component"
    );
    let source_commit = std::env::var("HMUX_SOURCE_COMMIT")
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| git_output(&["rev-parse", "HEAD"]))
        .unwrap_or_else(|| "unknown".to_owned());
    assert!(
        safe_source_commit(&source_commit),
        "HMUX_SOURCE_COMMIT must be a full lowercase commit SHA"
    );
    println!("cargo:rustc-env=HMUX_BUILD_ID={build_id}");
    println!("cargo:rustc-env=HMUX_SOURCE_COMMIT={source_commit}");
    println!(
        "cargo:rustc-env=HMUX_TARGET_TRIPLE={}",
        std::env::var("TARGET").expect("Cargo always sets TARGET")
    );
}
