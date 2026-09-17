//! Resolve staged file references on the machine that owns the session.
//! A foreground SSH command changes the filesystem in which pasted paths resolve.
//! Both the desktop and the remote CLI use this owner; terminal titles are never routes.

use crate::{
    LocalProcessGenerationStatus, LocalSessionCatalog, SessionDescriptor, SessionSelector,
    probe_local_process_generation,
};
use hebbian_bounded_process::{CommandSpec, run};
use hebbian_process_sampler::{
    ForegroundProcess, SharedProcessSampler, foreground_process_argv, process_cwd,
    process_start_time,
};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::OpenOptions;
use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

const MAX_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
struct SshRoute {
    process: ForegroundProcess,
    cwd: PathBuf,
    arguments: Vec<String>,
    configuration_digest: String,
}

fn configuration_digest(arguments: &[String], cwd: &Path) -> Result<String, String> {
    let mut command = CommandSpec::new("/usr/bin/ssh");
    command.arg("-G").args(arguments).current_dir(cwd);
    let output = run(&command, Duration::from_secs(5), 65_536)
        .map_err(|error| format!("session_file_ssh_config_unavailable: {}", error.stage()))?;
    if !output.status.success() || output.exceeded_limit {
        return Err("session_file_ssh_config_unavailable".into());
    }
    let text =
        std::str::from_utf8(&output.stdout).map_err(|_| "session_file_ssh_config_unavailable")?;
    for line in text.lines() {
        if let Some(value) = line.strip_prefix("remotecommand ") {
            if value != "none" {
                return Err("session_file_ssh_remote_command_unsupported".into());
            }
        }
        if line
            .strip_prefix("sessiontype ")
            .is_some_and(|value| value != "default")
        {
            return Err("session_file_ssh_remote_command_unsupported".into());
        }
    }
    Ok(format!("{:x}", Sha256::digest(&output.stdout)))
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct FileRoute {
    foreground: ForegroundProcess,
    ssh: Option<SshRoute>,
}

/// Preserve connection options, never the original remote command or forwarding.
/// Unknown options fail closed: silently dropping an identity/proxy option could
/// put the image on a different server. OpenSSH remains the config/key authority.
fn transfer_arguments(argv: &[String]) -> Result<Vec<String>, String> {
    let mut result = Vec::new();
    let mut index = 1;
    while let Some(arg) = argv.get(index) {
        if arg == "--" {
            index += 1;
            break;
        }
        if !arg.starts_with('-') {
            break;
        }
        if matches!(
            arg.as_str(),
            "-t" | "-tt" | "-T" | "-q" | "-v" | "-vv" | "-vvv" | "-C" | "-4" | "-6"
        ) {
            if matches!(arg.as_str(), "-C" | "-4" | "-6") {
                result.push(arg.clone());
            }
            index += 1;
            continue;
        }
        let option = arg.as_bytes().get(1).copied().unwrap_or_default();
        if !matches!(option, b'i' | b'p' | b'l' | b'F' | b'J' | b'S' | b'o') {
            return Err("session_file_ssh_options_unsupported".into());
        }
        let value = if arg.len() > 2 {
            arg[2..].to_string()
        } else {
            index += 1;
            argv.get(index)
                .cloned()
                .ok_or("session_file_ssh_option_missing")?
        };
        if value.is_empty() || value.chars().any(char::is_control) {
            return Err("session_file_ssh_option_invalid".into());
        }
        if option == b'o' {
            let name = value
                .split(['=', ' '])
                .next()
                .unwrap_or_default()
                .to_ascii_lowercase();
            if !matches!(
                name.as_str(),
                "hostname"
                    | "user"
                    | "port"
                    | "identityfile"
                    | "identitiesonly"
                    | "identityagent"
                    | "certificatefile"
                    | "proxyjump"
                    | "proxycommand"
                    | "userknownhostsfile"
                    | "globalknownhostsfile"
                    | "hostkeyalias"
                    | "hostkeyalgorithms"
                    | "pubkeyacceptedalgorithms"
                    | "canonicalizehostname"
                    | "controlpath"
                    | "connecttimeout"
                    | "serveraliveinterval"
                    | "serveralivecountmax"
            ) {
                return Err("session_file_ssh_options_unsupported".into());
            }
        }
        result.push(format!("-{}", char::from(option)));
        result.push(value);
        index += 1;
    }
    let destination = argv
        .get(index)
        .ok_or("session_file_ssh_destination_missing")?;
    if destination.is_empty()
        || destination.starts_with('-')
        || destination.len() > 512
        || destination
            .chars()
            .any(|ch| ch.is_control() || ch.is_whitespace())
    {
        return Err("session_file_ssh_destination_invalid".into());
    }
    // An explicit remote command can enter another namespace/hop. Its filesystem
    // cannot be inferred from the outer SSH connection.
    if argv.len() != index + 1 {
        return Err("session_file_ssh_remote_command_unsupported".into());
    }
    result.push(destination.clone());
    Ok(result)
}

fn observe_route(root_pid: u32, sampler: &SharedProcessSampler) -> Result<FileRoute, String> {
    // Coalesce with other Host census users. A forced fresh census refuses an
    // already-running sample; the complete-census owner bounds the wait and age.
    // Direct generation/argv checks below and around upload validate this witness.
    let snapshot = sampler
        .complete_process_snapshot_containing(root_pid, Duration::from_millis(500))
        .map_err(|e| e.to_string())?;
    let foreground = sampler
        .foreground_process(root_pid)
        .map_err(|e| e.to_string())?
        .ok_or("session_file_foreground_unavailable")?;
    let mut ancestry = HashSet::from([root_pid]);
    loop {
        let before = ancestry.len();
        for process in &snapshot.processes {
            if ancestry.contains(&process.parent_pid) {
                ancestry.insert(process.pid);
            }
        }
        if ancestry.len() == before {
            break;
        }
    }
    if !ancestry.contains(&foreground.pid) {
        return Err("session_file_process_changed".into());
    }
    let mut descendants = HashSet::from([foreground.pid]);
    loop {
        let before = descendants.len();
        for process in &snapshot.processes {
            if descendants.contains(&process.parent_pid) {
                descendants.insert(process.pid);
            }
        }
        if descendants.len() == before {
            break;
        }
    }
    let foreground_group = unsafe { libc::getpgid(foreground.pid as libc::pid_t) };
    if foreground_group <= 0 {
        return Err("session_file_foreground_unavailable".into());
    }
    let mut ssh = None;
    for pid in descendants {
        if unsafe { libc::getpgid(pid as libc::pid_t) } != foreground_group {
            continue;
        }
        let Some(start_time) = process_start_time(pid) else {
            return Err("session_file_process_changed".into());
        };
        let process = ForegroundProcess { pid, start_time };
        let argv = foreground_process_argv(process).ok_or("session_file_process_changed")?;
        if argv
            .first()
            .and_then(|arg| Path::new(arg).file_name())
            .is_none_or(|name| name != "ssh")
        {
            continue;
        }
        if ssh.is_some() {
            return Err("session_file_ssh_ambiguous".into());
        }
        let cwd = process_cwd(pid).ok_or("session_file_ssh_cwd_unavailable")?;
        let arguments = transfer_arguments(&argv)?;
        let configuration_digest = configuration_digest(&arguments, &cwd)?;
        ssh = Some(SshRoute {
            process,
            cwd,
            arguments,
            configuration_digest,
        });
    }
    if foreground_process_argv(foreground).is_none() {
        return Err("session_file_process_changed".into());
    }
    Ok(FileRoute { foreground, ssh })
}

fn verify_session(
    catalog: &LocalSessionCatalog,
    expected: &SessionDescriptor,
) -> Result<(), String> {
    let current = catalog
        .find(&SessionSelector::new(
            &expected.session_id,
            Some(expected.workspace_id.clone()),
        ))
        .map_err(|e| e.to_string())?;
    if !current.same_generation(expected)
        || probe_local_process_generation(&expected.host_process).map_err(|e| e.to_string())?
            != LocalProcessGenerationStatus::Live
        || probe_local_process_generation(&expected.provider_process).map_err(|e| e.to_string())?
            != LocalProcessGenerationStatus::Live
    {
        return Err("session_file_session_changed".into());
    }
    Ok(())
}

fn read_staged_file(path: &Path, remaining: u64) -> Result<Vec<u8>, String> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|e| format!("session_file_read_failed: {e}"))?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > remaining {
        return Err("session_file_size_limit".into());
    }
    let mut bytes = Vec::new();
    file.take(remaining + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > remaining {
        return Err("session_file_size_limit".into());
    }
    Ok(bytes)
}

fn upload_command(file_name: &str, byte_count: usize) -> String {
    format!(
        "set -eu\numask 077\nhmux_paste_directory=$(mktemp -d /tmp/hmux-paste.XXXXXX)\nhmux_paste_file=\"$hmux_paste_directory/{file_name}\"\ncat > \"$hmux_paste_file\"\ntest \"$(wc -c < \"$hmux_paste_file\")\" -eq {byte_count}\nprintf '%s\\n' \"$hmux_paste_file\""
    )
}

fn upload(route: &SshRoute, index: usize, source: &Path, bytes: Vec<u8>) -> Result<String, String> {
    let name: String = source
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("file")
        .chars()
        .take(120)
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let command = upload_command(&format!("{index}-{name}"), bytes.len());
    let mut spec = CommandSpec::new("/usr/bin/ssh");
    spec.args([
        "-oBatchMode=yes",
        "-oStrictHostKeyChecking=yes",
        "-oClearAllForwardings=yes",
        "-oRequestTTY=no",
        "-oRemoteCommand=none",
        "-oPermitLocalCommand=no",
        "-oControlMaster=no",
        "-oControlPersist=no",
        "-oConnectTimeout=10",
    ])
    .args(&route.arguments)
    .arg(command)
    .current_dir(&route.cwd)
    .input(bytes)
    .capture_stderr(true);
    let output = run(&spec, Duration::from_secs(60), 16_384)
        .map_err(|e| format!("session_file_ssh_failed: {}", e.stage()))?;
    if !output.status.success() || output.exceeded_limit {
        return Err(format!(
            "session_file_ssh_failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let path = String::from_utf8(output.stdout).map_err(|_| "session_file_ssh_path_invalid")?;
    let path = path.trim_end_matches('\n');
    let prefix = "/tmp/hmux-paste.";
    let tail = path
        .strip_prefix(prefix)
        .ok_or("session_file_ssh_path_invalid")?;
    let (suffix, filename) = tail
        .split_once('/')
        .ok_or("session_file_ssh_path_invalid")?;
    if suffix.len() != 6
        || !suffix.bytes().all(|b| b.is_ascii_alphanumeric())
        || filename != format!("{index}-{name}")
    {
        return Err("session_file_ssh_path_invalid".into());
    }
    Ok(path.into())
}

/// Staged paths already exist on this Host. Resolve them through its foreground
/// SSH connection if present, and refuse delivery after any session/route change.
pub fn route_files(
    catalog: &LocalSessionCatalog,
    selector: &SessionSelector,
    terminal_epoch: &str,
    paths: Vec<String>,
) -> Result<Vec<String>, String> {
    if paths.is_empty()
        || paths.len() > 5
        || paths
            .iter()
            .any(|path| !Path::new(path).is_absolute() || path.chars().any(char::is_control))
    {
        return Err("session_file_paths_invalid".into());
    }
    let session = catalog.find(selector).map_err(|e| e.to_string())?;
    if session.terminal_epoch != terminal_epoch {
        return Err("session_file_session_changed".into());
    }
    verify_session(catalog, &session)?;
    let sampler = SharedProcessSampler::host_default().map_err(|e| e.to_string())?;
    let route = observe_route(session.provider_process.process_id, &sampler)?;
    let Some(ssh) = &route.ssh else {
        return Ok(paths);
    };
    let mut remaining = MAX_BYTES;
    let mut uploaded = Vec::new();
    for (index, path) in paths.iter().enumerate() {
        let data = read_staged_file(Path::new(path), remaining)?;
        remaining -= data.len() as u64;
        verify_session(catalog, &session)?;
        if observe_route(session.provider_process.process_id, &sampler)? != route {
            return Err("session_file_ssh_changed".into());
        }
        uploaded.push(upload(ssh, index, Path::new(path), data)?);
    }
    verify_session(catalog, &session)?;
    if observe_route(session.provider_process.process_id, &sampler)? != route {
        return Err("session_file_ssh_changed".into());
    }
    Ok(uploaded)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|s| (*s).into()).collect()
    }

    #[test]
    fn upload_stream_preserves_binary_bytes_in_sh_and_zsh() {
        for shell in ["/bin/sh", "/bin/zsh"]
            .into_iter()
            .filter(|shell| Path::new(shell).is_file())
        {
            let bytes = b"\x89PNG\r\n\0'\xff";
            let mut command = CommandSpec::new(shell);
            command
                .args(["-c", &upload_command("0-image.png", bytes.len())])
                .input(bytes.to_vec())
                .capture_stderr(true);
            let output = run(&command, Duration::from_secs(5), 4096).unwrap();
            assert!(
                output.status.success(),
                "{shell}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            let path = String::from_utf8(output.stdout).unwrap();
            let path = Path::new(path.trim());
            assert!(path.starts_with("/tmp"));
            assert_eq!(std::fs::read(path).unwrap(), bytes);
            std::fs::remove_file(path).unwrap();
            std::fs::remove_dir(path.parent().unwrap()).unwrap();
        }
    }

    #[test]
    fn observes_config_changes_and_refuses_hidden_remote_commands() {
        let root = tempfile::tempdir().unwrap();
        let config = root.path().join("config");
        let arguments = vec![
            "-F".into(),
            config.to_str().unwrap().into(),
            "destination".into(),
        ];
        std::fs::write(
            &config,
            "Host destination\n  HostName 127.0.0.1\n  Port 2222\n",
        )
        .unwrap();
        let before = configuration_digest(&arguments, root.path()).unwrap();
        std::fs::write(
            &config,
            "Host destination\n  HostName 127.0.0.1\n  Port 2223\n",
        )
        .unwrap();
        assert_ne!(
            before,
            configuration_digest(&arguments, root.path()).unwrap()
        );
        std::fs::write(&config, "Host destination\n  RemoteCommand ssh inner\n").unwrap();
        assert_eq!(
            configuration_digest(&arguments, root.path()).unwrap_err(),
            "session_file_ssh_remote_command_unsupported"
        );
    }

    #[test]
    fn preserves_identity_port_user_config_and_jump_route() {
        assert_eq!(
            transfer_arguments(&args(&[
                "/usr/bin/ssh",
                "-tt",
                "-i",
                "~/.ssh/key.pem",
                "-p2222",
                "-l",
                "user",
                "-F",
                "config",
                "-Jjump",
                "host"
            ]))
            .unwrap(),
            args(&[
                "-i",
                "~/.ssh/key.pem",
                "-p",
                "2222",
                "-l",
                "user",
                "-F",
                "config",
                "-J",
                "jump",
                "host"
            ])
        );
    }

    #[test]
    fn refuses_tunnels_commands_and_unrecognized_connection_options() {
        for argv in [
            args(&["ssh", "-N", "host"]),
            args(&["ssh", "host", "ssh", "inner"]),
            args(&["ssh", "-o", "StrictHostKeyChecking=no", "host"]),
            args(&["ssh", "-i"]),
        ] {
            assert!(transfer_arguments(&argv).is_err());
        }
    }

    #[test]
    fn staged_reads_reject_symlinks_and_oversize_files() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        std::fs::write(&source, b"image").unwrap();
        let link = root.path().join("link");
        std::os::unix::fs::symlink(&source, &link).unwrap();
        assert!(read_staged_file(&link, 10).is_err());
        assert!(read_staged_file(&source, 4).is_err());
        assert_eq!(read_staged_file(&source, 5).unwrap(), b"image");
    }
}
