//! One system-ssh process for a remote pairing mutation.
//!
//! OpenSSH remains the authentication and routing authority. In particular,
//! config aliases stay opaque rather than being flattened into a second,
//! incomplete implementation of ProxyJump/Match/IdentityFile semantics.

use super::inventory::{HostTarget, InventoryHost, SshInvocation};
use base64::Engine as _;
use hmux_client::online_pairing::pairing_time_remaining;
use hmux_ssh_transport::openssh_host_key_algorithms;
#[cfg(test)]
use std::ffi::OsStr;
use std::io::{self, Read, Write as _};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::thread;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// Overrides the ssh executable, for tests and operators with a wrapper.
const SSH_PROGRAM_ENV: &str = "HMUX_PAIRING_SSH";
const MAX_DEBUG_LOG_BYTES: u64 = 64 * 1024;
const MAX_STDOUT_BYTES: u64 = 256 * 1024;
const MAX_STDERR_BYTES: u64 = 64 * 1024;
const DEBUG_LOG_POLL: Duration = Duration::from_millis(10);

/// A SHA-256 host-key pin parsed once at the OpenSSH process boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct HostKeyPin(String);

impl HostKeyPin {
    fn parse(value: &str) -> Result<Self, String> {
        let encoded = value
            .strip_prefix("SHA256:")
            .ok_or_else(|| format!("OpenSSH reported a non-SHA256 host-key pin: {value}"))?;
        let digest = base64::engine::general_purpose::STANDARD_NO_PAD
            .decode(encoded)
            .map_err(|error| format!("OpenSSH reported an invalid host-key pin: {error}"))?;
        if digest.len() != 32 {
            return Err(format!(
                "OpenSSH reported a {}-byte SHA-256 host-key pin",
                digest.len()
            ));
        }
        Ok(Self(value.to_owned()))
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

pub(crate) struct SystemSsh {
    program: String,
    connect_timeout_seconds: u32,
}

impl SystemSsh {
    pub(crate) fn from_environment(connect_timeout_seconds: u32) -> Self {
        Self {
            program: std::env::var(SSH_PROGRAM_ENV).unwrap_or_else(|_| "ssh".into()),
            connect_timeout_seconds,
        }
    }

    /// Runs a mutation after authorizing the key negotiated by this connection.
    ///
    /// Input is deliberately withheld until OpenSSH has authenticated and sent
    /// the remote command, then `authorize` runs while that process is blocked
    /// on stdin. A rejected or unrecordable identity terminates this exact child
    /// without mutating authorized_keys.
    pub(crate) fn run_authenticated<F>(
        &self,
        host: &InventoryHost,
        remote_arguments: &[&str],
        input: &str,
        deadline: Option<Instant>,
        authorize: F,
    ) -> Result<String, String>
    where
        F: FnOnce(&HostKeyPin) -> Result<(), String>,
    {
        let operation_deadline = self.operation_deadline();
        let deadline = deadline.map_or(operation_deadline, |deadline| {
            deadline.min(operation_deadline)
        });
        pairing_time_remaining(deadline).map_err(str::to_owned)?;
        let debug_log = tempfile::NamedTempFile::new()
            .map_err(|error| format!("could not create the private OpenSSH debug log: {error}"))?;
        let mut child = self.spawn(host, remote_arguments, Some(debug_log.path()))?;
        let pin = match self.wait_for_command_host_key(&mut child, debug_log.path(), host, deadline)
        {
            Ok(pin) => pin,
            Err(error) => {
                terminate(&mut child);
                return Err(error);
            }
        };
        if let Err(error) = authorize(&pin) {
            terminate(&mut child);
            return Err(error);
        }
        let stdout = self.send_and_finish(child, host, input, deadline)?;
        Ok(stdout)
    }

    fn spawn(
        &self,
        host: &InventoryHost,
        remote_arguments: &[&str],
        debug_log: Option<&Path>,
    ) -> Result<Child, String> {
        let mut command = self.command(host, remote_arguments, debug_log)?;
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("could not run {}: {error}", self.program))
    }

    fn command(
        &self,
        host: &InventoryHost,
        remote_arguments: &[&str],
        debug_log: Option<&Path>,
    ) -> Result<Command, String> {
        let invocation = match &host.target {
            HostTarget::Remote(invocation) => invocation,
            HostTarget::ThisLaptop => {
                return Err("system ssh cannot target this laptop's in-process row".into());
            }
        };
        let mut command = Command::new(&self.program);
        if matches!(invocation, SshInvocation::Explicit) {
            // Explicit inventory coordinates are the complete route. Reading
            // Host/Match rules here could silently add ProxyJump, HostName or
            // HostKeyAlias and mutate a different endpoint.
            command.arg("-F").arg("none");
        }
        command
            // Pairing has no terminal for prompts. Unknown or changed host
            // identities fail before mutation instead of silently becoming
            // trust-on-first-use.
            .arg("-o")
            .arg("BatchMode=yes")
            .arg("-o")
            .arg("StrictHostKeyChecking=yes")
            .arg("-o")
            .arg(format!("ConnectTimeout={}", self.connect_timeout_seconds))
            .arg("-o")
            .arg("ConnectionAttempts=1")
            // A multiplexed master would skip the handshake whose key we need.
            .arg("-o")
            .arg("ControlMaster=no")
            .arg("-o")
            .arg("ControlPath=none")
            // Pairing must not mutate trust files or execute config side effects.
            .arg("-o")
            .arg("UpdateHostKeys=no")
            .arg("-o")
            .arg("ClearAllForwardings=yes")
            .arg("-o")
            .arg("PermitLocalCommand=no")
            .arg("-o")
            .arg("RequestTTY=no")
            .arg("-o")
            .arg("FingerprintHash=sha256")
            .arg("-o")
            .arg(format!(
                "HostKeyAlgorithms={}",
                openssh_host_key_algorithms()
            ))
            // SSH config owns routing and authentication, not the byte
            // protocol this command must run after authentication.
            .arg("-o")
            .arg("SessionType=default")
            .arg("-o")
            .arg("StdinNull=no")
            .arg("-o")
            .arg("ForkAfterAuthentication=no")
            // A config-level RemoteCommand cannot coexist with a command after
            // the destination. Supplying our command as the command-line
            // option makes this pairing protocol the first and only value.
            .arg("-o")
            .arg(format!(
                "RemoteCommand={}",
                remote_command(remote_arguments)
            ));
        if let Some(path) = debug_log {
            command.arg("-v").arg("-E").arg(path);
        }
        match invocation {
            SshInvocation::Explicit => {
                command.arg("-p").arg(host.port.to_string());
                if host.auth == "key" {
                    if let Some(key_path) = &host.key_path {
                        command
                            .arg("-o")
                            .arg("IdentitiesOnly=yes")
                            .arg("-i")
                            .arg(expand_home(key_path));
                    }
                }
            }
            SshInvocation::ConfigAlias(_) => {
                // Routing and authentication stay config-owned, while the
                // account whose authorized_keys is mutated is pairing state.
                command.arg("-l").arg(&host.user);
            }
        }
        command.arg("--");
        match invocation {
            SshInvocation::Explicit => {
                command.arg(format!("{}@{}", host.user, host.host));
            }
            SshInvocation::ConfigAlias(alias) => {
                command.arg(alias);
            }
        }
        Ok(command)
    }

    fn wait_for_command_host_key(
        &self,
        child: &mut Child,
        debug_log: &Path,
        host: &InventoryHost,
        deadline: Instant,
    ) -> Result<HostKeyPin, String> {
        loop {
            pairing_time_remaining(deadline).map_err(str::to_owned)?;
            let log = read_bounded_debug_log(debug_log)?;
            if let Some(pin) = command_host_key(&log)? {
                return Ok(pin);
            }
            if let Some(status) = child
                .try_wait()
                .map_err(|error| format!("could not observe ssh to {}: {error}", host.host))?
            {
                return Err(format!(
                    "ssh to {} ended ({status}) before an authenticated remote command exposed its host key: {}",
                    host.host,
                    last_line(&log)
                ));
            }
            thread::sleep(DEBUG_LOG_POLL);
        }
    }

    fn send_and_finish(
        &self,
        mut child: Child,
        host: &InventoryHost,
        input: &str,
        deadline: Instant,
    ) -> Result<String, String> {
        if let Err(error) = pairing_time_remaining(deadline) {
            terminate(&mut child);
            return Err(error.to_owned());
        }
        let readers = match OutputReaders::start(&mut child) {
            Ok(readers) => readers,
            Err(error) => {
                terminate(&mut child);
                return Err(error);
            }
        };
        let write_result = child
            .stdin
            .take()
            .ok_or_else(|| "ssh stdin was not available".to_string())
            .and_then(|mut stdin| {
                stdin.write_all(input.as_bytes()).map_err(|error| {
                    format!("could not send the request to {}: {error}", host.host)
                })
            });
        if let Err(error) = write_result {
            terminate(&mut child);
            let _ = readers.finish(deadline);
            return Err(error);
        }
        let status = match wait_until(&mut child, deadline) {
            Ok(status) => status,
            Err(error) => {
                terminate(&mut child);
                let _ = readers.finish(deadline);
                return Err(format!("ssh to {} failed: {error}", host.host));
            }
        };
        let output = readers.finish(deadline)?;
        if !status.success() {
            return Err(format!(
                "ssh to {}@{}:{} failed ({}): {}",
                host.user,
                host.host,
                host.port,
                status,
                first_line(&output.stderr)
            ));
        }
        Ok(output.stdout)
    }

    fn operation_deadline(&self) -> Instant {
        // ProxyJump may consume one connection timeout per hop. This is one
        // whole-process bound shared by connect, authentication, and command.
        Instant::now()
            + Duration::from_secs(u64::from(self.connect_timeout_seconds).saturating_mul(3) + 5)
    }
}

fn command_host_key(log: &str) -> Result<Option<HostKeyPin>, String> {
    let Some(last_newline) = log.rfind('\n') else {
        return Ok(None);
    };
    let mut latest = None;
    for line in log[..=last_newline].lines() {
        let body = line
            .split_once("Server host key: ")
            .or_else(|| line.split_once("Server host certificate: "))
            .map(|(_, body)| body);
        if let Some(body) = body {
            let pin = body
                .split_ascii_whitespace()
                .nth(1)
                .ok_or_else(|| format!("OpenSSH reported an incomplete host-key line: {line}"))?;
            latest = Some(HostKeyPin::parse(pin)?);
        }
        // This marker belongs to the outer connection that is about to run
        // hmux. A ProxyJump process can authenticate earlier, so returning at
        // the first \"Authenticated to\" line could pin the jump host instead.
        if line.contains("Sending command:") {
            return latest.map(Some).ok_or_else(|| {
                "OpenSSH sent the remote command without reporting a host key".into()
            });
        }
    }
    Ok(None)
}

fn remote_command(arguments: &[&str]) -> String {
    // RemoteCommand expands OpenSSH percent tokens; the ordinary command argv
    // path did not. Doubling keeps a user-supplied command byte-equivalent.
    arguments.join(" ").replace('%', "%%")
}

struct CapturedOutput {
    stdout: String,
    stderr: String,
}

struct OutputReaders {
    stdout: JoinHandle<io::Result<BoundedOutput>>,
    stderr: JoinHandle<io::Result<BoundedOutput>>,
}

impl OutputReaders {
    fn start(child: &mut Child) -> Result<Self, String> {
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "ssh stdout was not available".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "ssh stderr was not available".to_string())?;
        Ok(Self {
            stdout: thread::spawn(move || read_bounded(stdout, MAX_STDOUT_BYTES)),
            stderr: thread::spawn(move || read_bounded(stderr, MAX_STDERR_BYTES)),
        })
    }

    fn finish(self, deadline: Instant) -> Result<CapturedOutput, String> {
        while !self.stdout.is_finished() || !self.stderr.is_finished() {
            if Instant::now() >= deadline {
                return Err("ssh output pipes remained open after the pairing deadline".into());
            }
            thread::sleep(DEBUG_LOG_POLL);
        }
        let stdout = join_output(self.stdout, "stdout")?;
        let stderr = join_output(self.stderr, "stderr")?;
        Ok(CapturedOutput { stdout, stderr })
    }
}

struct BoundedOutput {
    bytes: Vec<u8>,
    exceeded_limit: bool,
}

fn read_bounded(mut reader: impl Read, limit: u64) -> io::Result<BoundedOutput> {
    let mut bytes = Vec::new();
    (&mut reader).take(limit + 1).read_to_end(&mut bytes)?;
    let exceeded_limit = bytes.len() as u64 > limit;
    bytes.truncate(limit as usize);
    if exceeded_limit {
        io::copy(&mut reader, &mut io::sink())?;
    }
    Ok(BoundedOutput {
        bytes,
        exceeded_limit,
    })
}

fn join_output(
    reader: JoinHandle<io::Result<BoundedOutput>>,
    stream: &str,
) -> Result<String, String> {
    let output = reader
        .join()
        .map_err(|_| format!("ssh {stream} reader panicked"))?
        .map_err(|error| format!("could not read ssh {stream}: {error}"))?;
    if output.exceeded_limit {
        return Err(format!("ssh {stream} exceeded the pairing output limit"));
    }
    Ok(String::from_utf8_lossy(&output.bytes).into_owned())
}

fn wait_until(child: &mut Child, deadline: Instant) -> Result<ExitStatus, String> {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status),
            Ok(None) => {}
            Err(error) => {
                terminate(child);
                return Err(format!("could not observe the child process: {error}"));
            }
        }
        if Instant::now() >= deadline {
            terminate(child);
            return Err("the whole-process pairing deadline elapsed".into());
        }
        thread::sleep(DEBUG_LOG_POLL);
    }
}

fn read_bounded_debug_log(path: &Path) -> Result<String, String> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .map_err(|error| format!("could not read the OpenSSH debug log: {error}"))?
        .take(MAX_DEBUG_LOG_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("could not read the OpenSSH debug log: {error}"))?;
    if bytes.len() as u64 > MAX_DEBUG_LOG_BYTES {
        return Err("OpenSSH debug output exceeded the pairing limit".into());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn terminate(child: &mut Child) {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return;
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn first_line(text: &str) -> String {
    text.trim().lines().next().unwrap_or("").trim().to_owned()
}

fn last_line(text: &str) -> String {
    text.trim()
        .lines()
        .next_back()
        .unwrap_or("")
        .trim()
        .to_owned()
}

fn expand_home(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn remote(invocation: SshInvocation) -> InventoryHost {
        InventoryHost {
            id: "a".into(),
            name: "build box".into(),
            host: "decoy.example".into(),
            port: 2222,
            user: "decoy-user".into(),
            auth: "key".into(),
            key_path: Some("/decoy/key".into()),
            target: HostTarget::Remote(invocation),
        }
    }

    fn args(command: &Command) -> Vec<String> {
        command
            .get_args()
            .map(OsStr::to_string_lossy)
            .map(|argument| argument.into_owned())
            .collect()
    }

    #[test]
    fn a_config_alias_is_the_only_destination_authority() {
        let ssh = SystemSsh {
            program: "ssh".into(),
            connect_timeout_seconds: 10,
        };
        let args = args(
            &ssh.command(
                &remote(SshInvocation::ConfigAlias("build-via-bastion".into())),
                &["hmux", "pair", "apply-authorized-key"],
                None,
            )
            .unwrap(),
        );

        assert!(
            args.windows(2)
                .any(|pair| pair == ["--", "build-via-bastion"])
        );
        assert!(!args.iter().any(|argument| argument == "decoy.example"));
        assert!(!args.iter().any(|argument| argument == "/decoy/key"));
        assert!(!args.iter().any(|argument| argument == "-p"));
        assert!(!args.iter().any(|argument| argument == "-F"));
        assert!(args.windows(2).any(|pair| pair == ["-l", "decoy-user"]));
        assert_eq!(args.last().map(String::as_str), Some("build-via-bastion"));
        assert!(
            args.iter()
                .any(|argument| { argument == "RemoteCommand=hmux pair apply-authorized-key" })
        );
    }

    #[test]
    fn an_explicit_host_keeps_its_coordinates_and_key() {
        let ssh = SystemSsh {
            program: "ssh".into(),
            connect_timeout_seconds: 10,
        };
        let args = args(
            &ssh.command(
                &remote(SshInvocation::Explicit),
                &["hmux", "pair", "apply-authorized-key"],
                None,
            )
            .unwrap(),
        );

        assert!(args.windows(2).any(|pair| pair == ["-p", "2222"]));
        assert!(args.windows(2).any(|pair| pair == ["-F", "none"]));
        assert!(
            args.windows(2)
                .any(|pair| pair == ["-o", "IdentitiesOnly=yes"])
        );
        assert!(args.windows(2).any(|pair| pair == ["-i", "/decoy/key"]));
        assert!(args.iter().any(|argument| {
            argument == &format!("HostKeyAlgorithms={}", openssh_host_key_algorithms())
        }));
        assert!(
            args.windows(2)
                .any(|pair| pair == ["--", "decoy-user@decoy.example"])
        );
    }

    #[test]
    fn the_target_key_is_the_last_one_before_the_outer_command() {
        let log = "\
debug1: Server host key: ssh-ed25519 SHA256:iyf7zP84DbFOsPg+ZVHGJ+P4mZm20wy24p1qye5pnjk\n\
Authenticated to jump.example using publickey.\n\
debug1: Server host key: ssh-ed25519 SHA256:NFcLH9/wH3EK7sALDPE/VAZ2QF7R6V+zAL2UWC6DAqQ\n\
Authenticated to target.example using publickey.\n\
debug1: Sending command: hmux pair apply-authorized-key\n";

        assert_eq!(
            command_host_key(log).unwrap().unwrap().as_str(),
            "SHA256:NFcLH9/wH3EK7sALDPE/VAZ2QF7R6V+zAL2UWC6DAqQ"
        );
    }

    #[test]
    fn remote_command_escapes_openssh_percent_tokens() {
        assert_eq!(
            remote_command(&["/tmp/100%/hmux", "pair"]),
            "/tmp/100%%/hmux pair"
        );
    }

    #[test]
    fn a_key_is_not_authoritative_before_the_remote_command_starts() {
        let log = "debug1: Server host key: ssh-ed25519 \
                   SHA256:iyf7zP84DbFOsPg+ZVHGJ+P4mZm20wy24p1qye5pnjk\n";
        assert_eq!(command_host_key(log).unwrap(), None);
    }

    #[test]
    fn a_partially_appended_debug_line_waits_for_its_newline() {
        let partial = "debug1: Server host key: ssh-ed25519 SHA256:not-finished";
        assert_eq!(command_host_key(partial).unwrap(), None);
    }

    #[test]
    fn the_process_deadline_stops_the_exact_owned_child() {
        let mut child = Command::new("sh").args(["-c", "sleep 60"]).spawn().unwrap();
        let error = wait_until(&mut child, Instant::now() + Duration::from_millis(50)).unwrap_err();
        assert!(error.contains("deadline"), "{error}");
        assert!(
            child.try_wait().unwrap().is_some(),
            "the timed-out child must already be reaped"
        );
    }
}

#[cfg(all(test, unix))]
mod deadline_tests;
