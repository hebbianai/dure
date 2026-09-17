use super::{validate_published_file, write_owner_only_file};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const CLAUDE_SETTINGS_FILE: &str = "managed-claude-settings.json";
#[cfg(unix)]
const CLAUDE_HOOK_SCRIPT_FILE: &str = "managed-claude-hook-v2.sh";
#[cfg(not(unix))]
const CLAUDE_HOOK_SCRIPT_FILE: &str = "managed-claude-hook-v1.py";
#[derive(Clone)]
pub(super) struct PublishedClaudeSettings {
    pub(super) path: PathBuf,
    pub(super) contents: Vec<u8>,
    pub(super) script_path: PathBuf,
    pub(super) script_contents: Vec<u8>,
}

pub(super) fn published_claude_settings() -> &'static Mutex<Option<PublishedClaudeSettings>> {
    static PUBLISHED: OnceLock<Mutex<Option<PublishedClaudeSettings>>> = OnceLock::new();
    PUBLISHED.get_or_init(|| Mutex::new(None))
}

pub(super) fn claude_settings_path(control_dir: &Path) -> PathBuf {
    control_dir.join(CLAUDE_SETTINGS_FILE)
}

pub(super) fn claude_hook_script_path(control_dir: &Path) -> PathBuf {
    control_dir.join(CLAUDE_HOOK_SCRIPT_FILE)
}

pub(crate) fn claude_settings(script_path: &Path) -> Value {
    crate::managed_hook_rendering::claude_settings(&script_path.to_string_lossy())
}

pub(crate) fn publish_claude_settings(
    control_dir: &Path,
    resource_dir: &Path,
) -> std::io::Result<()> {
    #[cfg(unix)]
    let script_contents = {
        let channel = crate::app_channel::current().map_err(std::io::Error::other)?;
        let home = dirs::home_dir()
            .ok_or_else(|| std::io::Error::other("managed Claude home unavailable"))?;
        let runtime = crate::dure_cli_install::resolve_control_plane_companion(
            &channel.name,
            &home,
            resource_dir,
        )
        .map_err(std::io::Error::other)?;
        native_hook_shim(&runtime)?
    };
    #[cfg(not(unix))]
    let script_contents = {
        let _ = resource_dir;
        crate::managed_hook_rendering::MANAGED_PROVIDER_HOOK_SCRIPT.to_vec()
    };
    publish_claude_settings_from(control_dir, script_contents)
}

#[cfg(unix)]
pub(super) fn native_hook_shim(runtime: &Path) -> std::io::Result<Vec<u8>> {
    if !runtime.is_absolute() {
        return Err(std::io::Error::other(
            "managed Claude native runtime must be absolute",
        ));
    }
    let runtime = runtime
        .to_str()
        .ok_or_else(|| std::io::Error::other("managed Claude native runtime path must be UTF-8"))?;
    Ok(format!(
        "#!/bin/sh\nexec {} managed-claude-hook\n",
        super::shell_quote(runtime)
    )
    .into_bytes())
}

pub(super) fn publish_claude_settings_from(
    control_dir: &Path,
    script_contents: Vec<u8>,
) -> std::io::Result<()> {
    let path = claude_settings_path(control_dir);
    let script_path = claude_hook_script_path(control_dir);
    *published_claude_settings()
        .lock()
        .map_err(|_| std::io::Error::other("managed Claude settings registry poisoned"))? = None;
    let mut contents =
        serde_json::to_vec_pretty(&claude_settings(&script_path)).map_err(std::io::Error::other)?;
    contents.push(b'\n');
    write_owner_only_file(control_dir, &script_path, &script_contents, 0o700)?;
    write_owner_only_file(control_dir, &path, &contents, 0o600)?;
    *published_claude_settings()
        .lock()
        .map_err(|_| std::io::Error::other("managed Claude settings registry poisoned"))? =
        Some(PublishedClaudeSettings {
            path,
            contents,
            script_path,
            script_contents,
        });
    Ok(())
}

pub(super) fn validate_published_claude_settings(
    path: &Path,
    published: &PublishedClaudeSettings,
) -> Result<(), String> {
    if published.path != path {
        return Err(
            "managed_hook_settings_unavailable: settings were not published by this app process"
                .to_string(),
        );
    }
    validate_published_file(
        path,
        &published.contents,
        "Claude settings",
        "managed_hook_settings_unavailable",
    )?;
    // Both the settings and native shim must still match this publication.
    // Owner-only permissions alone do not establish the executable generation.
    validate_published_file(
        &published.script_path,
        &published.script_contents,
        "Claude channel handoff script",
        "managed_hook_settings_unavailable",
    )?;
    Ok(())
}

/// 발행된 managed Claude settings가 지금도 유효한가 — 설정 화면의 배선 상태
/// 표시용 비파괴 프로브. inject 경로와 같은 검증(발행자·내용 일치)을 쓴다.
pub(crate) fn claude_settings_available() -> bool {
    let Ok(guard) = published_claude_settings().lock() else {
        return false;
    };
    let Some(published) = guard.clone() else {
        return false;
    };
    drop(guard);
    validate_published_claude_settings(&published.path, &published).is_ok()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn channel_publications_preserve_each_others_receipts() {
        let mut invalidated = Vec::new();
        for (first, second) in [
            ("", "channels/dev-first-a1b2c3d4"),
            ("channels/dev-first-a1b2c3d4", ""),
            (
                "channels/dev-first-a1b2c3d4",
                "channels/dev-second-a1b2c3d4",
            ),
        ] {
            let root = tempfile::tempdir().unwrap();
            let channels = root.path().join("channels");
            std::fs::create_dir(&channels).unwrap();
            std::fs::set_permissions(&channels, std::fs::Permissions::from_mode(0o700)).unwrap();
            let publish = |channel: &str, runtime: &str| {
                let directory = root.path().join(channel);
                std::fs::create_dir_all(&directory).unwrap();
                std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))
                    .unwrap();
                let script_contents = native_hook_shim(Path::new(runtime)).unwrap();
                publish_claude_settings_from(&directory, script_contents.clone()).unwrap();
                let path = claude_settings_path(&directory);
                // Each app keeps its own receipt; avoid reading another test's
                // publication from the process-global registry.
                PublishedClaudeSettings {
                    contents: std::fs::read(&path).unwrap(),
                    path,
                    script_path: claude_hook_script_path(&directory),
                    script_contents,
                }
            };

            let first_publication = publish(first, "/fixture/first/bin/dure-control-plane");
            validate_published_claude_settings(&first_publication.path, &first_publication)
                .unwrap();
            let second_publication = publish(second, "/fixture/second/bin/dure-control-plane");
            validate_published_claude_settings(&second_publication.path, &second_publication)
                .unwrap();
            if let Err(error) =
                validate_published_claude_settings(&first_publication.path, &first_publication)
            {
                invalidated.push(format!("{first:?} after {second:?}: {error}"));
            }

            let updated = publish(second, "/fixture/updated/bin/dure-control-plane");
            validate_published_claude_settings(&updated.path, &updated).unwrap();
            assert!(validate_published_claude_settings(
                &second_publication.path,
                &second_publication
            )
            .unwrap_err()
            .contains("changed after publication"));
            if let Err(error) =
                validate_published_claude_settings(&first_publication.path, &first_publication)
            {
                invalidated.push(format!("{first:?} after {second:?} update: {error}"));
            }
        }
        assert!(invalidated.is_empty(), "{}", invalidated.join("\n"));
    }

    #[test]
    fn native_shim_executes_the_exact_companion_with_an_empty_path() {
        let root = tempfile::tempdir().unwrap();
        let executable = root.path().join("runtime with 'quotes");
        std::fs::write(&executable, b"#!/bin/sh\n/usr/bin/printf '%s' \"$1\"\n").unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let shim = root.path().join("hook.sh");
        std::fs::write(&shim, native_hook_shim(&executable).unwrap()).unwrap();
        std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o700)).unwrap();
        let output = std::process::Command::new(shim)
            .env_clear()
            .env("PATH", "")
            .args(["claude", "--managed-direct", "--terminal-events"])
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"managed-claude-hook");
        assert!(output.stderr.is_empty());
        assert!(native_hook_shim(Path::new("relative/runtime")).is_err());
    }
}
