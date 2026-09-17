//! Repository-scoped issue reads over an app-owned SSH connection. GitHub
//! credentials and command execution remain on the desktop; no remote shell
//! input is executed locally.

mod query;

use crate::{remote_path::RemotePosixPath, ssh};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

const CLIENT: &str = include_str!("remote_github/client.py");
const SERVER: &str = include_str!("remote_github/server.py");
const MAX_REQUEST: u64 = 16_384;

struct Bridge {
    directory: String,
    alive: Arc<AtomicBool>,
}

struct Liveness(Arc<AtomicBool>);

impl Drop for Liveness {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// Optional integration: a folder without a GitHub origin still launches normally.
/// A GitHub query failure is returned by the shim, never disguised as an empty list.
pub(crate) fn prepare(opts: &ssh::SshOptions, home: &RemotePosixPath, cwd: &str) -> Option<String> {
    match ensure(opts, home, cwd) {
        Ok(directory) => directory,
        Err(error) => {
            eprintln!("remote_github_unavailable: {error}");
            None
        }
    }
}

fn ensure(
    opts: &ssh::SshOptions,
    home: &RemotePosixPath,
    cwd: &str,
) -> Result<Option<String>, String> {
    static BRIDGES: OnceLock<Mutex<HashMap<String, Bridge>>> = OnceLock::new();
    let channel = crate::app_channel::current().map_err(|error| error.to_string())?;
    let mut pins = opts.host_key_fingerprints.clone();
    pins.sort();
    if pins.is_empty() {
        return Err("a pinned SSH host key is required".into());
    }
    let identity = serde_json::to_vec(&json!([
        channel.control_dir,
        opts.host,
        opts.port.unwrap_or(22),
        opts.user,
        pins,
        cwd
    ]))
    .map_err(|error| error.to_string())?;
    let key = format!("{:x}", Sha256::digest(identity));
    let directory = home
        .join_relative(&format!(".local/share/dure/github-bridge-v1/{key}"))
        .map_err(|error| error.to_string())?
        .to_string();
    // ponytail: preparation is serialized across hosts (at most the SSH startup
    // timeout). Replace with per-key admission if parallel launches need it.
    let mut bridges = BRIDGES
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|error| error.to_string())?;
    bridges.retain(|_, bridge| bridge.alive.load(Ordering::Acquire));
    if let Some(bridge) = bridges.get(&key) {
        return Ok(Some(bridge.directory.clone()));
    }
    let Some((session, transport, repository)) = connect(opts, &directory, cwd, None)? else {
        return Ok(None);
    };
    let alive = Arc::new(AtomicBool::new(true));
    let liveness = Liveness(Arc::clone(&alive));
    let options = opts.clone();
    let bridge_directory = directory.clone();
    let cwd = cwd.to_owned();
    std::thread::Builder::new().name("remote-github".into()).spawn(move || {
        let _liveness = liveness;
        let mut connection = (session, transport);
        // ponytail: one worker per scope lives until the desktop exits, as did
        // the original bridge. Add session leases if inactive scopes accumulate.
        loop {
            if let Err(error) = serve(&mut connection.1, &repository) {
                eprintln!("remote_github_disconnected: {error}");
            }
            let _ = connection.1.get_mut().close();
            drop(connection);
            let mut delay = 1;
            connection = loop {
                std::thread::sleep(std::time::Duration::from_secs(delay));
                match connect(&options, &bridge_directory, &cwd, Some(&repository)) {
                    Ok(Some((session, transport, _))) => break (session, transport),
                    Ok(None) => eprintln!("remote_github_reconnect: GitHub origin is unavailable"),
                    Err(error) => eprintln!("remote_github_reconnect: {error}"),
                }
                delay = (delay * 2).min(30);
            };
        }
    }).map_err(|error| error.to_string())?;
    bridges.insert(
        key,
        Bridge {
            directory: directory.clone(),
            alive,
        },
    );
    Ok(Some(directory))
}

fn connect(
    opts: &ssh::SshOptions,
    directory: &str,
    cwd: &str,
    expected_repository: Option<&str>,
) -> Result<Option<(ssh2::Session, BufReader<ssh2::Channel>, String)>, String> {
    let session = ssh::connect(opts)?;
    session.set_timeout(30_000);
    let script = format!(
        "CLIENT_SOURCE = {}\n{SERVER}",
        serde_json::to_string(CLIENT).map_err(|error| error.to_string())?
    );
    let command = format!(
        "exec python3 -u -c {} {} {}",
        ssh::shell_quote(&script),
        ssh::shell_quote(directory),
        ssh::shell_quote(cwd)
    );
    let mut transport = session
        .channel_session()
        .map_err(|error| error.to_string())?;
    transport
        .exec(&command)
        .map_err(|error| error.to_string())?;
    let mut transport = BufReader::new(transport);
    let hello = read_request(&mut transport)?;
    let Some(repository) = hello
        .get("origin")
        .and_then(Value::as_str)
        .and_then(query::repository)
    else {
        let _ = transport.get_mut().close();
        return Ok(None);
    };
    if hello.get("directory").and_then(Value::as_str) != Some(directory) {
        return Err("remote GitHub directory does not match the requested scope".into());
    }
    if expected_repository.is_some_and(|expected| expected != repository) {
        return Err("remote GitHub origin changed from the pinned repository".into());
    }
    write_response(&mut transport, &json!({"ready": true}))?;
    if read_request(&mut transport)? != json!({"listening": true}) {
        return Err("remote GitHub listener did not become ready".into());
    }
    Ok(Some((session, transport, repository)))
}

fn serve(transport: &mut BufReader<ssh2::Channel>, repository: &str) -> Result<(), String> {
    loop {
        let request = read_request(transport)?;
        let response = if request == json!({"heartbeat": true}) {
            json!({"ready": true})
        } else {
            serde_json::to_value(query::execute(repository, request)).unwrap_or_else(|_| json!({
                "stdout": "", "stderr": "Dure GitHub response could not be encoded.\n", "code": 1
            }))
        };
        // Reconnect the transport, never replay a GitHub command.
        write_response(transport, &response)?;
    }
}

fn read_request(reader: &mut impl BufRead) -> Result<Value, String> {
    let mut bytes = Vec::new();
    std::io::Read::take(reader, MAX_REQUEST + 1)
        .read_until(b'\n', &mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_REQUEST || bytes.last() != Some(&b'\n') {
        return Err("remote GitHub request is incomplete or too large".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "remote GitHub request is invalid".into())
}

fn write_response(writer: &mut BufReader<ssh2::Channel>, value: &Value) -> Result<(), String> {
    serde_json::to_writer(writer.get_mut(), value).map_err(|error| error.to_string())?;
    writer
        .get_mut()
        .write_all(b"\n")
        .and_then(|()| writer.get_mut().flush())
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_frames_reject_partial_oversized_and_malformed_requests() {
        for bytes in [
            b"{}".to_vec(),
            b"no json\n".to_vec(),
            vec![b'x'; MAX_REQUEST as usize + 1],
        ] {
            assert!(read_request(&mut bytes.as_slice()).is_err());
        }
        assert_eq!(
            read_request(&mut b"{\"heartbeat\":true}\n".as_slice()).unwrap(),
            json!({"heartbeat": true})
        );
    }

    #[test]
    #[ignore = "requires the disposable SSH server from remote-github-ssh-smoke.mjs"]
    fn reads_issues_over_real_ssh_using_desktop_gh() {
        let options: ssh::SshOptions =
            serde_json::from_str(&std::env::var("DURE_GITHUB_QA_SSH").unwrap()).unwrap();
        let root = std::env::var("DURE_GITHUB_QA_ROOT").unwrap();
        let home = RemotePosixPath::from_absolute(&root).unwrap();
        let cwd = format!("{root}/repo");
        assert_ne!(ssh::exec_once(&options, "command -v gh").unwrap().code, 0);
        let directory = ensure(&options, &home, &cwd)
            .unwrap()
            .expect("GitHub origin");
        assert_eq!(
            ensure(&options, &home, &cwd).unwrap().as_deref(),
            Some(directory.as_str())
        );
        // Remote PATH has no native gh; it also has an empty GitHub config root.
        // Both commands must therefore traverse SSH back to the desktop executor.
        let remote = |arguments: &str| {
            let command = crate::remote_provider_runtime::launch_command(
                "claude",
                dure_app::AgentProviderLaunchPlanV1 {
                    executable: "/bin/sh".into(),
                    arguments: vec!["-c".into(), format!("gh {arguments}")],
                },
                None,
                Some(&directory),
            )
            .unwrap();
            ssh::exec_once(
                &options,
                &format!(
                    "GH_CONFIG_DIR={} {}",
                    ssh::shell_quote(&format!("{root}/empty-gh")),
                    command
                        .iter()
                        .map(|word| ssh::shell_quote(word))
                        .collect::<Vec<_>>()
                        .join(" ")
                ),
            )
            .unwrap()
        };
        let result = remote("issue view 1 --json number,title,comments");
        assert_eq!(result.code, 0, "{}", result.stderr);
        assert!(
            result.stderr.is_empty(),
            "desktop GH_DEBUG must not reach the remote host"
        );
        let issue: Value = serde_json::from_str(&result.stdout).unwrap();
        assert_eq!(issue["number"], 1);
        assert!(issue["comments"].is_array());
        let result = remote("issue list --limit 1 --json number,title");
        assert_eq!(result.code, 0, "{}", result.stderr);
        assert!(serde_json::from_str::<Value>(&result.stdout)
            .unwrap()
            .is_array());
        // A malformed frame closes the desktop transport without stopping the
        // agent. Its existing PATH must work again without another prepare().
        let fault = r#"import json, pathlib, socket, sys, time
path = pathlib.Path(sys.argv[1]) / 'connection.json'
before = path.read_text()
with socket.socket(socket.AF_UNIX) as client:
    client.settimeout(10)
    client.connect(json.loads(before)['socket'])
    client.sendall(b'NaN\n')
    client.recv(1)
deadline = time.monotonic() + 15
while path.read_text() == before and time.monotonic() < deadline:
    time.sleep(0.1)
assert path.read_text() != before, 'desktop did not reconnect the existing bridge'
"#;
        let result = ssh::exec_once(&options, &format!(
            "python3 -c {} {}", ssh::shell_quote(fault), ssh::shell_quote(&directory)
        )).unwrap();
        assert_eq!(result.code, 0, "{}", result.stderr);
        let result = remote("issue view 1 --json number,title,comments");
        assert_eq!(result.code, 0, "{}", result.stderr);
        assert_eq!(serde_json::from_str::<Value>(&result.stdout).unwrap()["number"], 1);
        // A reconnect must validate the original repository before publishing a
        // listener, even when another valid GitHub origin is supplied.
        assert!(connect(&options, &directory, &cwd, Some("other/repo"))
            .err().unwrap().contains("pinned repository"));
        let result = remote("issue list --limit 1 --json number");
        assert_eq!(result.code, 0, "{}", result.stderr);
        for arguments in [
            "auth token",
            "issue close 1",
            "issue view 1 --repo other/repo",
        ] {
            let result = remote(arguments);
            assert_eq!(result.code, 1);
            assert!(result.stdout.is_empty());
            assert!(result.stderr.contains("supports only"));
        }
        println!("SSH GitHub reads: local gh returned issue 1 with comments and a bounded list before and after transport loss; changed reconnect scope, writes, auth token and foreign repository reads refused");
    }
}
