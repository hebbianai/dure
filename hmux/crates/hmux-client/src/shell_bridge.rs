use std::ffi::{OsStr, OsString};
use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

const ORIGINAL_ZDOTDIR_ENV: &str = "HMUX_COMMAND_BRIDGE_ORIGINAL_ZDOTDIR";

#[derive(Debug)]
pub struct InteractiveShellBridgeError(String);

#[derive(Debug)]
struct ZshLaunchState {
    original_zdotdir: PathBuf,
    init_root: String,
    bridge: String,
}

impl fmt::Display for InteractiveShellBridgeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for InteractiveShellBridgeError {}

/// Start an interactive user shell whose final startup state keeps one private
/// command bridge at the front of `PATH`.
///
/// A simple parent-process `PATH` prefix is insufficient: ordinary `.zshrc`
/// and `.bash_profile` files commonly rebuild `PATH`, silently moving the
/// bridge behind `/usr/bin` or a provider installation. The generated startup
/// adapter first evaluates the user's normal startup files and only then
/// reinstates the private prefix in that same shell process, preserving aliases,
/// functions, options, and prompt setup.
pub fn interactive_shell_with_command_bridge(
    shell: &Path,
    home: &Path,
    bridge: &Path,
    extra_environment: &[(&str, &str)],
) -> Result<Vec<String>, InteractiveShellBridgeError> {
    let shell_name = shell
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| error("interactive shell name is not UTF-8"))?;
    let shell = utf8_path(shell, "interactive shell")?;
    let home = home
        .canonicalize()
        .map_err(|error| error_with("resolve interactive shell home", error))?;
    let bridge = bridge
        .canonicalize()
        .map_err(|error| error_with("resolve command bridge directory", error))?;
    refuse_symlink_or_non_directory(&bridge, "command bridge directory")?;
    set_private_directory_permissions(&bridge)?;
    let init_root = bridge.join(".shell-init-v1");
    fs::create_dir_all(&init_root)
        .map_err(|error| error_with("create command bridge shell init directory", error))?;
    refuse_symlink_or_non_directory(&init_root, "command bridge shell init directory")?;
    set_private_directory_permissions(&init_root)?;
    let init_root = init_root
        .canonicalize()
        .map_err(|error| error_with("resolve command bridge shell init directory", error))?;
    if init_root.parent() != Some(bridge.as_path()) {
        return Err(error(
            "command bridge shell init directory escaped its private bridge",
        ));
    }

    let mut command = vec!["/usr/bin/env".to_string()];
    for (key, value) in extra_environment {
        if key.is_empty() || key.contains('=') || key.contains('\0') || value.contains('\0') {
            return Err(error("command bridge environment assignment is invalid"));
        }
        command.push(format!("{key}={value}"));
    }

    match shell_name {
        "zsh" => {
            let launch_state = zsh_launch_state(
                &home,
                &init_root,
                &bridge,
                std::env::var_os(ORIGINAL_ZDOTDIR_ENV),
                std::env::var_os("ZDOTDIR"),
            )?;
            let original_zdotdir = utf8_path(&launch_state.original_zdotdir, "original ZDOTDIR")?;
            command.push(format!("{ORIGINAL_ZDOTDIR_ENV}={original_zdotdir}"));
            for startup_file in [".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout"] {
                let script = zsh_startup_script(
                    startup_file,
                    &original_zdotdir,
                    &launch_state.init_root,
                    &launch_state.bridge,
                )?;
                write_exact_private_file(&init_root.join(startup_file), script.as_bytes())?;
            }
            command.push(format!("ZDOTDIR={}", launch_state.init_root));
            command.push(shell);
            command.push("-l".to_string());
        }
        "bash" => {
            let home_text = utf8_path(&home, "interactive shell home")?;
            let bridge_text = utf8_path(&bridge, "command bridge directory")?;
            let bashrc = init_root.join("bashrc");
            let script = format!(
                "if [[ -r /etc/profile ]]; then source /etc/profile; fi\n\
                 if [[ -r {home}/.bash_profile ]]; then\n\
                   source {home}/.bash_profile\n\
                 elif [[ -r {home}/.bash_login ]]; then\n\
                   source {home}/.bash_login\n\
                 elif [[ -r {home}/.profile ]]; then\n\
                   source {home}/.profile\n\
                 fi\n\
                 export PATH={bridge}:\"${{PATH:-}}\"\n",
                home = shell_quote(&home_text),
                bridge = shell_quote(&bridge_text),
            );
            write_exact_private_file(&bashrc, script.as_bytes())?;
            command.push(shell);
            command.push("--noprofile".to_string());
            command.push("--rcfile".to_string());
            command.push(utf8_path(&bashrc, "command bridge bash startup file")?);
            command.push("-i".to_string());
        }
        "fish" => {
            let bridge_text = utf8_path(&bridge, "command bridge directory")?;
            command.push(shell);
            command.push("--login".to_string());
            command.push("--interactive".to_string());
            command.push("--init-command".to_string());
            command.push(format!("set -gx PATH {} $PATH", fish_quote(&bridge_text)));
        }
        "sh" | "dash" | "ksh" | "mksh" => {
            let bridge_text = utf8_path(&bridge, "command bridge directory")?;
            let shrc = init_root.join("shrc");
            let original_env = std::env::var_os("ENV")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from);
            let source_original = original_env
                .as_deref()
                .map(|path| {
                    utf8_path(path, "original ENV startup file").map(|path| {
                        format!(
                            "if [ -r {path} ]; then . {path}; fi\n",
                            path = shell_quote(&path)
                        )
                    })
                })
                .transpose()?
                .unwrap_or_default();
            let script = format!(
                "{source_original}export PATH={bridge}:\"${{PATH:-}}\"\n",
                bridge = shell_quote(&bridge_text),
            );
            write_exact_private_file(&shrc, script.as_bytes())?;
            command.push(format!(
                "ENV={}",
                utf8_path(&shrc, "command bridge POSIX startup file")?
            ));
            command.push(shell);
            command.push("-l".to_string());
        }
        _ => {
            return Err(error(format!(
                "interactive shell `{shell_name}` is unsupported for command interception"
            )));
        }
    }
    Ok(command)
}

fn zsh_launch_state(
    home: &Path,
    init_root: &Path,
    bridge: &Path,
    inherited_original: Option<OsString>,
    current: Option<OsString>,
) -> Result<ZshLaunchState, InteractiveShellBridgeError> {
    if let Some(existing) = existing_zsh_launch_state(init_root, bridge)? {
        return Ok(existing);
    }
    Ok(ZshLaunchState {
        original_zdotdir: original_zdotdir_for_bridge(home, init_root, inherited_original, current),
        init_root: utf8_path(init_root, "command bridge shell init directory")?,
        bridge: utf8_path(bridge, "command bridge directory")?,
    })
}

fn existing_zsh_launch_state(
    init_root: &Path,
    bridge: &Path,
) -> Result<Option<ZshLaunchState>, InteractiveShellBridgeError> {
    let zshenv_path = init_root.join(".zshenv");
    if !zshenv_path
        .try_exists()
        .map_err(|error| error_with("inspect command bridge zsh init bundle", error))?
    {
        return Ok(None);
    }
    let zshenv = read_private_file(&zshenv_path)?;
    let zshenv = std::str::from_utf8(&zshenv)
        .map_err(|_| error("command bridge shell init conflicts with existing private state"))?;
    let lines = zshenv.lines().collect::<Vec<_>>();
    let original_text = lines
        .first()
        .and_then(|line| parse_zdotdir_assignment(line))
        .ok_or_else(|| error("command bridge shell init conflicts with existing private state"))?;
    let recorded_init_root = lines
        .get(4)
        .and_then(|line| parse_zdotdir_assignment(line))
        .ok_or_else(|| error("command bridge shell init conflicts with existing private state"))?;
    let recorded_init_path = PathBuf::from(&recorded_init_root);
    if recorded_init_path.file_name() != Some(OsStr::new(".shell-init-v1")) {
        return Err(error(
            "command bridge shell init conflicts with existing private state",
        ));
    }
    let recorded_bridge_path = recorded_init_path
        .parent()
        .ok_or_else(|| error("command bridge shell init conflicts with existing private state"))?;
    let canonical_recorded_init = recorded_init_path
        .canonicalize()
        .map_err(|_| error("command bridge shell init conflicts with existing private state"))?;
    let canonical_recorded_bridge = recorded_bridge_path
        .canonicalize()
        .map_err(|_| error("command bridge shell init conflicts with existing private state"))?;
    if canonical_recorded_init != init_root || canonical_recorded_bridge != bridge {
        return Err(error(
            "command bridge shell init conflicts with existing private state",
        ));
    }
    let recorded_bridge = utf8_path(recorded_bridge_path, "recorded command bridge directory")?;
    for startup_file in [".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout"] {
        let current = read_private_file(&init_root.join(startup_file))?;
        let expected = zsh_startup_script(
            startup_file,
            &original_text,
            &recorded_init_root,
            &recorded_bridge,
        )?;
        if current != expected.as_bytes() {
            return Err(error(
                "command bridge shell init conflicts with existing private state",
            ));
        }
    }
    Ok(Some(ZshLaunchState {
        original_zdotdir: PathBuf::from(original_text),
        init_root: recorded_init_root,
        bridge: recorded_bridge,
    }))
}

fn parse_zdotdir_assignment(line: &str) -> Option<String> {
    line.strip_prefix("typeset -gx ZDOTDIR=")
        .and_then(parse_shell_quote)
}

fn original_zdotdir_for_bridge(
    home: &Path,
    init_root: &Path,
    inherited_original: Option<OsString>,
    current: Option<OsString>,
) -> PathBuf {
    let candidate = inherited_original
        .filter(|value| !value.is_empty())
        .or_else(|| current.filter(|value| !value.is_empty()))
        .map(PathBuf::from);
    match candidate {
        Some(path) if path == init_root => home.to_path_buf(),
        Some(path) => path,
        None => home.to_path_buf(),
    }
}

fn zsh_startup_script(
    startup_file: &str,
    original_zdotdir: &str,
    init_root: &str,
    bridge: &str,
) -> Result<String, InteractiveShellBridgeError> {
    let original = Path::new(original_zdotdir).join(startup_file);
    let original = utf8_path(&original, "original zsh startup file")?;
    let mut script = format!(
        "typeset -gx ZDOTDIR={}\nif [[ -r {} ]]; then\n  source {}\nfi\ntypeset -gx ZDOTDIR={}\n",
        shell_quote(original_zdotdir),
        shell_quote(&original),
        shell_quote(&original),
        shell_quote(init_root),
    );
    if startup_file != ".zlogout" {
        script.push_str(&format!(
            "typeset -ga path\npath=({bridge} ${{path:#{bridge}}})\nexport PATH\n",
            bridge = shell_quote(bridge),
        ));
    }
    Ok(script)
}

fn parse_shell_quote(value: &str) -> Option<String> {
    let inner = value.strip_prefix('\'')?.strip_suffix('\'')?;
    let mut parsed = String::new();
    let mut remaining = inner;
    while let Some(index) = remaining.find('\'') {
        parsed.push_str(&remaining[..index]);
        remaining = remaining[index..].strip_prefix("'\"'\"'")?;
        parsed.push('\'');
    }
    parsed.push_str(remaining);
    Some(parsed)
}

fn utf8_path(path: &Path, label: &str) -> Result<String, InteractiveShellBridgeError> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| error(format!("{label} is not UTF-8")))
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn fish_quote(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'"))
}

fn refuse_symlink_or_non_directory(
    path: &Path,
    label: &str,
) -> Result<(), InteractiveShellBridgeError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| error_with(format!("inspect {label}"), error))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(error(format!("{label} is a symlink or non-directory")));
    }
    Ok(())
}

fn write_exact_private_file(
    path: &Path,
    expected: &[u8],
) -> Result<(), InteractiveShellBridgeError> {
    if path
        .try_exists()
        .map_err(|error| error_with("inspect command bridge shell init file", error))?
    {
        let metadata = fs::symlink_metadata(path)
            .map_err(|error| error_with("inspect command bridge shell init metadata", error))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(error(
                "command bridge shell init file is a symlink or non-file",
            ));
        }
        let current = fs::read(path)
            .map_err(|error| error_with("read command bridge shell init file", error))?;
        if current != expected {
            return Err(error(
                "command bridge shell init conflicts with existing private state",
            ));
        }
    } else {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|error| error_with("create command bridge shell init exclusively", error))?;
        file.write_all(expected)
            .and_then(|()| file.sync_all())
            .map_err(|error| error_with("write command bridge shell init", error))?;
    }
    set_private_file_permissions(path)
}

fn read_private_file(path: &Path) -> Result<Vec<u8>, InteractiveShellBridgeError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| error_with("inspect command bridge shell init metadata", error))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(error(
            "command bridge shell init file is a symlink or non-file",
        ));
    }
    fs::read(path).map_err(|error| error_with("read command bridge shell init file", error))
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) -> Result<(), InteractiveShellBridgeError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|error| error_with("protect command bridge directory", error))
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_path: &Path) -> Result<(), InteractiveShellBridgeError> {
    Ok(())
}

#[cfg(unix)]
fn set_private_file_permissions(path: &Path) -> Result<(), InteractiveShellBridgeError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| error_with("protect command bridge shell init file", error))
}

#[cfg(not(unix))]
fn set_private_file_permissions(_path: &Path) -> Result<(), InteractiveShellBridgeError> {
    Ok(())
}

fn error(message: impl Into<String>) -> InteractiveShellBridgeError {
    InteractiveShellBridgeError(message.into())
}

fn error_with(
    context: impl fmt::Display,
    source: impl fmt::Display,
) -> InteractiveShellBridgeError {
    error(format!("{context} failed: {source}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::process::Command;

    #[test]
    fn zsh_restart_unwraps_its_private_init_root() {
        let home = Path::new("/home/example");
        let init_root = Path::new("/private/bridge/.shell-init-v1");
        let custom = OsString::from("/home/example/.config/zsh");

        assert_eq!(
            original_zdotdir_for_bridge(
                home,
                init_root,
                None,
                Some(init_root.as_os_str().to_owned()),
            ),
            home,
        );
        assert_eq!(
            original_zdotdir_for_bridge(
                home,
                init_root,
                Some(custom.clone()),
                Some(init_root.as_os_str().to_owned()),
            ),
            PathBuf::from(custom),
        );
    }

    #[test]
    fn zsh_restart_reuses_an_existing_bundle_across_private_roots() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let bridge = root.path().join("bridge");
        let init_root = bridge.join(".shell-init-v1");
        let foreign_init_root = root.path().join("foreign-bridge/.shell-init-v1");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&init_root).unwrap();
        let home = home.canonicalize().unwrap();
        let bridge = bridge.canonicalize().unwrap();
        let init_root = init_root.canonicalize().unwrap();
        let home_text = home.to_str().unwrap();
        let bridge_text = bridge.to_str().unwrap();
        let init_root_text = init_root.to_str().unwrap();
        for startup_file in [".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout"] {
            fs::write(
                init_root.join(startup_file),
                zsh_startup_script(startup_file, home_text, init_root_text, bridge_text).unwrap(),
            )
            .unwrap();
        }

        assert_eq!(
            original_zdotdir_for_bridge(
                &home,
                &init_root,
                None,
                Some(foreign_init_root.as_os_str().to_owned()),
            ),
            foreign_init_root,
        );
        let launch = zsh_launch_state(
            &home,
            &init_root,
            &bridge,
            None,
            Some(foreign_init_root.as_os_str().to_owned()),
        )
        .unwrap();
        assert_eq!(launch.original_zdotdir, home);
        assert_eq!(launch.init_root, init_root_text);
        assert_eq!(launch.bridge, bridge_text);
    }

    #[cfg(unix)]
    #[test]
    fn zsh_restart_reuses_an_exact_bundle_through_a_canonical_state_alias() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let state = root.path().join(".dure");
        let alias = root.path().join(".hebbian");
        let bridge = state.join("bridge");
        let init_root = bridge.join(".shell-init-v1");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&init_root).unwrap();
        symlink(".dure", &alias).unwrap();
        let home = home.canonicalize().unwrap();
        let bridge = bridge.canonicalize().unwrap();
        let init_root = init_root.canonicalize().unwrap();
        let recorded_bridge = alias.join("bridge");
        let recorded_init_root = recorded_bridge.join(".shell-init-v1");
        let home_text = home.to_str().unwrap();
        let recorded_bridge_text = recorded_bridge.to_str().unwrap();
        let recorded_init_text = recorded_init_root.to_str().unwrap();
        for startup_file in [".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout"] {
            fs::write(
                init_root.join(startup_file),
                zsh_startup_script(
                    startup_file,
                    home_text,
                    recorded_init_text,
                    recorded_bridge_text,
                )
                .unwrap(),
            )
            .unwrap();
        }

        let launch = zsh_launch_state(&home, &init_root, &bridge, None, None).unwrap();

        assert_eq!(launch.original_zdotdir, home);
        assert_eq!(launch.init_root, recorded_init_text);
        assert_eq!(launch.bridge, recorded_bridge_text);
        assert!(
            interactive_shell_with_command_bridge(Path::new("/bin/zsh"), &home, &bridge, &[])
                .is_ok()
        );
    }

    #[test]
    fn zsh_restart_rejects_an_exact_bundle_bound_to_another_directory() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let bridge = root.path().join("bridge");
        let init_root = bridge.join(".shell-init-v1");
        let foreign_bridge = root.path().join("foreign-bridge");
        let foreign_init_root = foreign_bridge.join(".shell-init-v1");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&init_root).unwrap();
        fs::create_dir_all(&foreign_init_root).unwrap();
        let home = home.canonicalize().unwrap();
        let bridge = bridge.canonicalize().unwrap();
        let init_root = init_root.canonicalize().unwrap();
        let home_text = home.to_str().unwrap();
        let foreign_bridge_text = foreign_bridge.to_str().unwrap();
        let foreign_init_text = foreign_init_root.to_str().unwrap();
        for startup_file in [".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout"] {
            fs::write(
                init_root.join(startup_file),
                zsh_startup_script(
                    startup_file,
                    home_text,
                    foreign_init_text,
                    foreign_bridge_text,
                )
                .unwrap(),
            )
            .unwrap();
        }

        let error = zsh_launch_state(&home, &init_root, &bridge, None, None).unwrap_err();

        assert!(
            error
                .to_string()
                .contains("conflicts with existing private state")
        );
    }

    #[test]
    fn zsh_restart_rejects_a_modified_existing_bundle() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let bridge = root.path().join("bridge");
        let init_root = bridge.join(".shell-init-v1");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&init_root).unwrap();
        fs::write(init_root.join(".zshenv"), "source /tmp/untrusted\n").unwrap();

        let error = zsh_launch_state(&home, &init_root, &bridge, None, None).unwrap_err();

        assert!(
            error
                .to_string()
                .contains("conflicts with existing private state")
        );
    }

    #[cfg(unix)]
    #[test]
    fn zsh_user_path_rewrite_cannot_shadow_the_command_bridge() {
        if !Path::new("/bin/zsh").is_file() {
            return;
        }
        let home = tempfile::tempdir().unwrap();
        let bridge = home.path().join("bridge");
        fs::create_dir(&bridge).unwrap();
        fs::write(
            home.path().join(".zshrc"),
            "export PATH=/usr/bin:/bin:$PATH\n",
        )
        .unwrap();
        fs::write(bridge.join("ssh"), "#!/bin/sh\nexit 0\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(bridge.join("ssh"), fs::Permissions::from_mode(0o700)).unwrap();

        let launch =
            interactive_shell_with_command_bridge(Path::new("/bin/zsh"), home.path(), &bridge, &[])
                .unwrap();
        let mut probe = Command::new(&launch[0]);
        probe.args(&launch[1..]);
        probe.args(["-i", "-c", "command -v ssh"]);
        probe.env("HOME", home.path());
        let output = probe.output().unwrap();

        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            PathBuf::from(String::from_utf8_lossy(&output.stdout).trim())
                .canonicalize()
                .unwrap(),
            bridge.join("ssh").canonicalize().unwrap()
        );
        let mut path_probe = Command::new(&launch[0]);
        path_probe.args(&launch[1..]);
        path_probe.args([
            "-i",
            "-c",
            &format!(
                "typeset -i count=0; for entry in $path; do [[ $entry == {} ]] && (( count += 1 )); done; print -r -- $count",
                shell_quote(bridge.canonicalize().unwrap().to_str().unwrap())
            ),
        ]);
        path_probe.env("HOME", home.path());
        let path_output = path_probe.output().unwrap();
        assert!(
            path_output.status.success(),
            "{}",
            String::from_utf8_lossy(&path_output.stderr)
        );
        assert_eq!(
            String::from_utf8_lossy(&path_output.stdout)
                .lines()
                .next_back(),
            Some("1")
        );
    }

    #[cfg(unix)]
    #[test]
    fn shell_init_refuses_a_symlink() {
        use std::os::unix::fs::symlink;
        let home = tempfile::tempdir().unwrap();
        let bridge = home.path().join("bridge");
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir(&bridge).unwrap();
        symlink(outside.path(), bridge.join(".shell-init-v1")).unwrap();

        let error =
            interactive_shell_with_command_bridge(Path::new("/bin/zsh"), home.path(), &bridge, &[])
                .unwrap_err();

        assert!(error.to_string().contains("symlink"));
    }
}
