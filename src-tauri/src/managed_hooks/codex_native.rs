use super::{published_codex_notify, shell_quote, validate_published_file, write_owner_only_file};
use std::path::{Path, PathBuf};

#[derive(Clone)]
pub(super) struct PublishedLauncher {
    path: PathBuf,
    contents: Vec<u8>,
}

pub(crate) fn publish_codex_runtime(
    control_dir: &Path,
    runtime: &Path,
    resource_dir: &Path,
) -> std::io::Result<()> {
    let channel = crate::app_channel::current().map_err(std::io::Error::other)?;
    let home = dirs::home_dir()
        .ok_or_else(|| std::io::Error::other("managed provider home unavailable"))?;
    let companion = crate::dure_cli_install::resolve_control_plane_companion(
        &channel.name,
        &home,
        resource_dir,
    )
    .map_err(std::io::Error::other)?;
    super::publish_codex_notify(control_dir, runtime)?;
    let path = control_dir.join("managed-codex-native.sh");
    let environment = crate::accounts::provider_default_state_environment("codex")
        .map_err(std::io::Error::other)?;
    let root = super::effective_codex_config_root(&environment).map_err(std::io::Error::other)?;
    let chain = super::codex_notify_chain(&root).map_err(std::io::Error::other)?;
    let notify = super::publish_codex_user_notify_wrapper(control_dir, &chain)
        .map_err(std::io::Error::other)?;
    let contents = launcher_script(&companion, runtime, notify.as_deref())?;
    write_owner_only_file(control_dir, &path, &contents, 0o700)?;
    let mut published = published_codex_notify()
        .lock()
        .map_err(|_| std::io::Error::other("managed Codex publication poisoned"))?;
    let published = published
        .as_mut()
        .ok_or_else(|| std::io::Error::other("managed Codex notify was not published"))?;
    published.launcher = Some(PublishedLauncher { path, contents });
    Ok(())
}

fn launcher_script(
    companion: &Path,
    runtime: &Path,
    notify: Option<&Path>,
) -> std::io::Result<Vec<u8>> {
    let path = |path: &Path| {
        path.to_str()
            .filter(|_| path.is_absolute())
            .map(shell_quote)
            .ok_or_else(|| {
                std::io::Error::other("native provider executable must be an absolute UTF-8 path")
            })
    };
    let notification = serde_json::to_string(
        &notify
            .into_iter()
            .map(|path| path.to_string_lossy())
            .collect::<Vec<_>>(),
    )?;
    Ok(format!("#!/bin/sh\nprovider_executable=$1\nshift\nexec {} codex-native-driver --runtime {} -- \"$provider_executable\" -c {} \"$@\"\n",
        path(companion)?, path(runtime)?, shell_quote(&format!("notify={notification}"))).into_bytes())
}

pub(super) fn launcher_path() -> Result<Option<String>, String> {
    let launcher = published_codex_notify()
        .lock()
        .map_err(|_| "managed Codex publication poisoned".to_string())?
        .as_ref()
        .and_then(|published| published.launcher.clone());
    let Some(launcher) = launcher else {
        return Ok(None);
    };
    validate_published_file(
        &launcher.path,
        &launcher.contents,
        "Codex native launcher",
        "managed_codex_launcher_unavailable",
    )?;
    Ok(Some(launcher.path.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn launcher_preserves_the_pinned_program_resume_and_profile_override() {
        let root = tempfile::tempdir().unwrap();
        let companion = root.path().join("fixture companion");
        std::fs::write(&companion, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n").unwrap();
        std::fs::set_permissions(&companion, std::fs::Permissions::from_mode(0o700)).unwrap();
        let launcher = root.path().join("launcher");
        std::fs::write(
            &launcher,
            launcher_script(
                &companion,
                Path::new("/fixture/hmux runtime"),
                Some(Path::new("/fixture/user notify")),
            )
            .unwrap(),
        )
        .unwrap();
        let output = std::process::Command::new("/bin/sh")
            .arg(&launcher)
            .args([
                "/fixture/pinned codex",
                "-c",
                "notify=[profile-notify]",
                "resume",
                "exact-conversation",
            ])
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout)
                .unwrap()
                .lines()
                .collect::<Vec<_>>(),
            vec![
                "codex-native-driver",
                "--runtime",
                "/fixture/hmux runtime",
                "--",
                "/fixture/pinned codex",
                "-c",
                "notify=[\"/fixture/user notify\"]",
                "-c",
                "notify=[profile-notify]",
                "resume",
                "exact-conversation",
            ]
        );
    }

    #[test]
    fn stream_launch_removes_managed_state_hooks_but_keeps_user_notification() {
        let root = tempfile::tempdir().unwrap();
        let command = super::super::inject_provider_settings_from(
            "codex",
            "codex resume exact-conversation",
            root.path(),
            &["/fixture/user-notify".into()],
            Some("/fixture/native-launcher"),
        )
        .unwrap();
        assert!(command.starts_with("'/fixture/native-launcher' codex "));
        assert!(command.ends_with("resume exact-conversation"));
        assert!(command.contains("managed-codex-user-notify-"));
        assert!(!command.contains("managed-codex-notify.sh"));
        assert!(!command.contains("hooks.SessionStart"));
        assert!(!command.contains("hooks.UserPromptSubmit"));
        assert!(!command.contains("hooks.Interrupt"));
        assert!(!command.contains("bypass-hook-trust"));
    }
}
