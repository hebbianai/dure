use std::ffi::OsString;
use std::path::PathBuf;
use std::process::{Command, Output};

#[cfg(unix)]
const DEFAULT_LOGIN_SHELL: &str = "/bin/sh";
#[cfg(windows)]
const DEFAULT_LOGIN_SHELL: &str = "bash.exe";

/// Resolve the user's login shell without assuming that zsh is installed.
///
/// Desktop launches do not reliably inherit a provider-ready PATH, so callers
/// still start a login shell. Linux installations commonly use bash, fish, or
/// POSIX sh and are not required to ship `/bin/zsh`.
pub fn resolve_login_shell() -> PathBuf {
    resolve_login_shell_from(std::env::var_os("SHELL"))
}

pub fn run(command: &str) -> std::io::Result<Output> {
    let mut process = Command::new(resolve_login_shell());
    process.args(["-lc", command]);
    // The app installs its CLI here. GUI launch PATH and non-interactive shell
    // startup files do not reliably include the user's interactive PATH.
    if let Some(path) = login_command_path(dirs::home_dir(), std::env::var_os("PATH")) {
        process.env("PATH", path);
    }
    process.output()
}

fn login_command_path(home: Option<PathBuf>, path: Option<OsString>) -> Option<OsString> {
    let Some(home) = home else {
        return path;
    };
    let user_commands = home.join(".local").join("bin");
    let mut entries = vec![user_commands.clone()];
    if let Some(path) = path.as_ref() {
        entries.extend(std::env::split_paths(path).filter(|entry| entry != &user_commands));
    }
    std::env::join_paths(entries).ok().or(path)
}

fn resolve_login_shell_from(shell: Option<OsString>) -> PathBuf {
    shell
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_LOGIN_SHELL))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_the_configured_login_shell() {
        assert_eq!(
            resolve_login_shell_from(Some(OsString::from("/usr/bin/fish"))),
            PathBuf::from("/usr/bin/fish")
        );
    }

    #[test]
    fn empty_or_missing_shell_uses_the_platform_default() {
        assert_eq!(
            resolve_login_shell_from(Some(OsString::new())),
            PathBuf::from(DEFAULT_LOGIN_SHELL)
        );
        assert_eq!(
            resolve_login_shell_from(None),
            PathBuf::from(DEFAULT_LOGIN_SHELL)
        );
    }

    #[test]
    fn includes_the_canonical_user_command_directory() {
        let home = PathBuf::from("/Users/me");
        let inherited = std::env::join_paths(["/usr/bin", "/bin"]).unwrap();
        let path = login_command_path(Some(home.clone()), Some(inherited)).unwrap();
        let entries = std::env::split_paths(&path).collect::<Vec<_>>();

        assert_eq!(entries[0], home.join(".local").join("bin"));
        assert_eq!(
            entries[1..],
            [PathBuf::from("/usr/bin"), PathBuf::from("/bin")]
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_default_does_not_require_zsh() {
        assert_eq!(DEFAULT_LOGIN_SHELL, "/bin/sh");
    }

    #[cfg(windows)]
    #[test]
    fn windows_default_uses_the_git_bash_command_contract() {
        assert_eq!(DEFAULT_LOGIN_SHELL, "bash.exe");
    }
}
