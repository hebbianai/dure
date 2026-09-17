use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri_build::{DefaultPermissionRule, InlinedPlugin};

fn git_output(args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .ok()?;
    output.status.success().then(|| {
        String::from_utf8_lossy(&output.stdout)
            .trim()
            .to_string()
    })
}

fn emit_git_revision_rerun_paths() {
    if let Some(head) = git_output(&["rev-parse", "--git-path", "HEAD"]) {
        println!("cargo:rerun-if-changed={head}");
    }
    if let Some(reference) = git_output(&["symbolic-ref", "-q", "HEAD"]) {
        if let Some(reference_path) = git_output(&["rev-parse", "--git-path", &reference]) {
            println!("cargo:rerun-if-changed={reference_path}");
        }
        if let Some(packed_refs) = git_output(&["rev-parse", "--git-path", "packed-refs"]) {
            println!("cargo:rerun-if-changed={packed_refs}");
        }
    }
}

fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri must live under the repository root")
        .to_path_buf()
}

fn valid_runtime_fingerprint(value: &str) -> bool {
    value
        .strip_prefix("git-object-v1:")
        .is_some_and(|digest| {
            matches!(digest.len(), 40 | 64)
                && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
}

fn backend_runtime_fingerprint(repository_root: &Path) -> Option<String> {
    let script = repository_root.join("scripts/lib/backend-runtime-fingerprint.mjs");
    let output = Command::new("node")
        .arg(script)
        .arg("--root")
        .arg(repository_root)
        .current_dir(repository_root)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?.trim().to_string();
    valid_runtime_fingerprint(&value).then_some(value)
}

fn emit_backend_runtime_rerun_paths(repository_root: &Path) {
    let manifest = repository_root.join("scripts/backend-runtime-inputs.txt");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!(
        "cargo:rerun-if-changed={}",
        repository_root
            .join("scripts/lib/backend-runtime-fingerprint.mjs")
            .display()
    );
    let Ok(source) = fs::read_to_string(manifest) else {
        return;
    };
    for input in source
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
    {
        if let Some(prefix) = input.strip_prefix("artifact-prefix:") {
            let relative = Path::new(prefix);
            let Some(directory) = relative.parent() else {
                continue;
            };
            let Some(name_prefix) = relative.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            let directory = repository_root.join(directory);
            println!("cargo:rerun-if-changed={}", directory.display());
            if let Ok(entries) = fs::read_dir(&directory) {
                for entry in entries.flatten() {
                    if entry
                        .file_name()
                        .to_str()
                        .is_some_and(|name| name.starts_with(name_prefix))
                    {
                        println!("cargo:rerun-if-changed={}", entry.path().display());
                    }
                }
            }
            continue;
        }
        println!(
            "cargo:rerun-if-changed={}",
            repository_root.join(input).display()
        );
    }
}

fn main() {
    let repository_root = repository_root();
    let version = env!("CARGO_PKG_VERSION");
    let revision = git_output(&["rev-parse", "--short=12", "HEAD"])
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "unknown".to_string());
    let dirty = git_output(&["status", "--porcelain", "--untracked-files=no"])
        .is_some_and(|value| !value.is_empty());
    let suffix = if dirty { "-dirty" } else { "" };
    println!("cargo:rustc-env=DURE_BUILD_ID={version}+{revision}{suffix}");
    let runtime_fingerprint =
        backend_runtime_fingerprint(&repository_root).unwrap_or_else(|| "unavailable".into());
    if runtime_fingerprint == "unavailable" {
        println!(
            "cargo:warning=backend runtime fingerprint unavailable; compatibility will fail closed"
        );
    }
    println!("cargo:rustc-env=DURE_BACKEND_RUNTIME_FINGERPRINT={runtime_fingerprint}");

    emit_git_revision_rerun_paths();
    emit_backend_runtime_rerun_paths(&repository_root);
    println!(
        "cargo:rerun-if-changed={}",
        repository_root.join("plugins/beads").display()
    );
    println!("cargo:rerun-if-changed=src");
    let window_focus_qa = InlinedPlugin::new()
        .commands(&["window_context", "report_window", "storage_snapshot", "storage_native_peer"])
        .default_permission(DefaultPermissionRule::AllowAllCommands);
    tauri_build::try_build(
        tauri_build::Attributes::new().plugin("window-focus-qa", window_focus_qa),
    )
    .expect("failed to run Tauri build script")
}
