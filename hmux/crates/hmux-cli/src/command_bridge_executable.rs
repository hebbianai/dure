use crate::CliError;
use semver::Version;
use std::ffi::OsStr;
use std::io::Read;
use std::path::{Path, PathBuf};

const MAX_NVM_NODE_VERSIONS: usize = 128;
const MAX_SHEBANG_BYTES: u64 = 256;

#[derive(Debug)]
pub(crate) struct ResolvedCommand {
    pub(crate) command: Vec<String>,
}

pub(crate) fn resolve(bridge_dir: &Path, command: &str) -> Result<ResolvedCommand, CliError> {
    let path = std::env::var_os("PATH")
        .ok_or_else(|| CliError("command bridge PATH is unavailable".into()))?;
    resolve_with_home(bridge_dir, command, &path, dirs::home_dir().as_deref())
}

fn resolve_with_home(
    bridge_dir: &Path,
    command: &str,
    path: &OsStr,
    home: Option<&Path>,
) -> Result<ResolvedCommand, CliError> {
    validate_command(command)?;
    let bridge = bridge_dir
        .canonicalize()
        .map_err(|error| CliError(format!("command bridge directory is unavailable: {error}")))?;
    if let Some(executable) = resolve_in_path(&bridge, command, path)? {
        return Ok(command_from_paths([executable]));
    }
    if let Some(home) = home {
        if let Some(executable) = resolve_in_nvm(&bridge, command, home)? {
            return Ok(executable);
        }
    }
    Err(CliError(format!(
        "command bridge could not find the real `{command}` executable"
    )))
}

fn validate_command(command: &str) -> Result<(), CliError> {
    if command.is_empty()
        || command.len() > 64
        || !command
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._+-".contains(&byte))
    {
        return Err(CliError("command bridge executable name is invalid".into()));
    }
    Ok(())
}

fn resolve_in_path(
    bridge: &Path,
    command: &str,
    path: &OsStr,
) -> Result<Option<PathBuf>, CliError> {
    for directory in std::env::split_paths(path) {
        let candidate = directory.join(command);
        if let Some(executable) = validated_executable(&candidate, bridge)? {
            return Ok(Some(executable));
        }
    }
    Ok(None)
}

fn resolve_in_nvm(
    bridge: &Path,
    command: &str,
    home: &Path,
) -> Result<Option<ResolvedCommand>, CliError> {
    let versions_root = home.join(".nvm/versions/node");
    let versions_root = match versions_root.canonicalize() {
        Ok(root) if root.is_dir() => root,
        Ok(_) => return Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(CliError(format!(
                "command bridge NVM versions are unavailable: {error}"
            )));
        }
    };
    let entries = std::fs::read_dir(&versions_root).map_err(|error| {
        CliError(format!(
            "command bridge NVM versions are unavailable: {error}"
        ))
    })?;
    let mut best: Option<(Version, ResolvedCommand)> = None;
    for (index, entry) in entries.enumerate() {
        if index >= MAX_NVM_NODE_VERSIONS {
            return Err(CliError(
                "command bridge NVM version inventory exceeds the bounded limit".into(),
            ));
        }
        let entry = entry.map_err(|error| {
            CliError(format!(
                "command bridge NVM version inventory is unavailable: {error}"
            ))
        })?;
        if !entry
            .file_type()
            .is_ok_and(|file_type| file_type.is_dir() && !file_type.is_symlink())
        {
            continue;
        }
        let Some(version) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.strip_prefix('v'))
            .and_then(|name| Version::parse(name).ok())
        else {
            continue;
        };
        let version_root = entry.path().canonicalize().map_err(|error| {
            CliError(format!(
                "command bridge NVM version is unavailable: {error}"
            ))
        })?;
        if !version_root.starts_with(&versions_root) {
            continue;
        }
        let candidate = version_root.join("bin").join(command);
        let Some(executable) = validated_executable(&candidate, bridge)? else {
            continue;
        };
        if !executable.starts_with(&version_root) {
            continue;
        }
        let resolved = if node_shebang(&executable)? {
            let Some(node) = validated_executable(&version_root.join("bin").join("node"), bridge)?
            else {
                continue;
            };
            if !node.starts_with(&version_root) {
                continue;
            }
            command_from_paths([node, executable])
        } else {
            command_from_paths([executable])
        };
        if best.as_ref().is_none_or(|(current, _)| version > *current) {
            best = Some((version, resolved));
        }
    }
    Ok(best.map(|(_, executable)| executable))
}

fn command_from_paths<const LENGTH: usize>(paths: [PathBuf; LENGTH]) -> ResolvedCommand {
    ResolvedCommand {
        command: paths
            .into_iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect(),
    }
}

fn node_shebang(path: &Path) -> Result<bool, CliError> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .and_then(|file| file.take(MAX_SHEBANG_BYTES).read_to_end(&mut bytes))
        .map_err(|error| CliError(format!("command bridge executable is unavailable: {error}")))?;
    let first_line = bytes
        .split(|byte| *byte == b'\n')
        .next()
        .unwrap_or_default();
    Ok(first_line.starts_with(b"#!")
        && first_line
            .split(|byte| byte.is_ascii_whitespace())
            .any(|word| word == b"node" || word.ends_with(b"/node")))
}

fn validated_executable(candidate: &Path, bridge: &Path) -> Result<Option<PathBuf>, CliError> {
    if !executable_file(candidate) {
        return Ok(None);
    }
    let executable = candidate
        .canonicalize()
        .map_err(|error| CliError(format!("command bridge executable is unavailable: {error}")))?;
    if executable.starts_with(bridge) {
        return Ok(None);
    }
    Ok(Some(executable))
}

#[cfg(unix)]
fn executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn executable_file(path: &Path) -> bool {
    path.is_file()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};

    fn executable(path: &Path) {
        std::fs::write(path, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
    }

    #[test]
    fn path_prefers_the_real_executable_after_its_private_bridge() {
        let state = tempfile::tempdir().unwrap();
        let bridge = state.path().join("bridge");
        let real = state.path().join("real");
        std::fs::create_dir_all(&bridge).unwrap();
        std::fs::create_dir_all(&real).unwrap();
        executable(&bridge.join("codex"));
        executable(&real.join("codex"));
        let path = std::env::join_paths([bridge.as_path(), real.as_path()]).unwrap();
        assert_eq!(
            resolve_with_home(&bridge, "codex", &path, None)
                .unwrap()
                .command,
            [real
                .join("codex")
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .into_owned()]
        );
        assert!(resolve_with_home(&bridge, "../codex", &path, None).is_err());
    }

    #[test]
    fn nvm_fallback_finds_the_newest_confined_real_executable() {
        let state = tempfile::tempdir().unwrap();
        let bridge = state.path().join("bridge");
        let versions = state.path().join(".nvm/versions/node");
        std::fs::create_dir_all(&bridge).unwrap();
        executable(&bridge.join("codex"));
        for version in ["v20.20.2", "v24.14.1"] {
            let bin = versions.join(version).join("bin");
            let package = versions.join(version).join("lib/node_modules/codex/bin");
            std::fs::create_dir_all(&bin).unwrap();
            std::fs::create_dir_all(&package).unwrap();
            std::fs::write(package.join("codex.js"), "#!/usr/bin/env node\n").unwrap();
            std::fs::set_permissions(
                package.join("codex.js"),
                std::fs::Permissions::from_mode(0o700),
            )
            .unwrap();
            executable(&bin.join("node"));
            symlink("../lib/node_modules/codex/bin/codex.js", bin.join("codex")).unwrap();
        }
        let path = std::env::join_paths([bridge.as_path()]).unwrap();
        assert_eq!(
            resolve_with_home(&bridge, "codex", &path, Some(state.path()))
                .unwrap()
                .command,
            [
                versions
                    .join("v24.14.1/bin/node")
                    .canonicalize()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                versions
                    .join("v24.14.1/lib/node_modules/codex/bin/codex.js")
                    .canonicalize()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            ]
        );
    }

    #[test]
    fn nvm_fallback_refuses_an_executable_symlink_that_escapes_its_version() {
        let state = tempfile::tempdir().unwrap();
        let bridge = state.path().join("bridge");
        let bin = state.path().join(".nvm/versions/node/v24.14.1/bin");
        let outside = state.path().join("outside");
        std::fs::create_dir_all(&bridge).unwrap();
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        executable(&bridge.join("codex"));
        executable(&outside.join("codex"));
        symlink(outside.join("codex"), bin.join("codex")).unwrap();
        let path = std::env::join_paths([bridge.as_path()]).unwrap();
        let error = resolve_with_home(&bridge, "codex", &path, Some(state.path())).unwrap_err();
        assert_eq!(
            error.0,
            "command bridge could not find the real `codex` executable"
        );
    }
}
