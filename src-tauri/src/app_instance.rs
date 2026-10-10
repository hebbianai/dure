//! Ownership of this app channel's publications, not of Hmux sessions.
//! The kernel lock is retained until process exit and is never unlinked: a
//! persistent inode prevents old/new contenders from locking different files.

use std::fs::{File, OpenOptions};
use std::io::{self, Read};
use std::sync::OnceLock;

use fs2::FileExt;

use crate::app_channel::AppChannel;

pub(crate) const LOCK_VERSION: u8 = 1;
const LOCK_FILE: &str = "app-instance-v1.lock";
const MAX_DESCRIPTOR_BYTES: u64 = 32 * 1024;
static INSTANCE: OnceLock<AppInstance> = OnceLock::new();

pub(crate) struct AppInstance {
    channel: AppChannel,
    _lock: File,
}

impl Drop for AppInstance {
    fn drop(&mut self) {
        // Explicit release also covers a concurrent fork's brief inherited
        // descriptor before exec closes it. The inode itself stays in place.
        let _ = FileExt::unlock(&self._lock);
    }
}

impl AppInstance {
    pub(crate) fn channel(&self) -> &AppChannel {
        &self.channel
    }

    fn acquire(channel: AppChannel) -> io::Result<Option<Self>> {
        let path = channel.control_dir.join(LOCK_FILE);
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // Keep the lock inode from being renamed/deleted while held.
            options.share_mode(0x1 | 0x2); // FILE_SHARE_READ | FILE_SHARE_WRITE
        }
        if path
            .symlink_metadata()
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err(io::Error::other("app_instance_lock_unsafe"));
        }
        let lock = options.open(path)?;
        let metadata = lock.metadata()?;
        if !metadata.is_file() {
            return Err(io::Error::other("app_instance_lock_unsafe"));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.uid() != unsafe { libc::geteuid() }
                || metadata.nlink() != 1
                || metadata.mode() & 0o077 != 0
            {
                return Err(io::Error::other("app_instance_lock_unsafe"));
            }
        }
        match FileExt::try_lock_exclusive(&lock) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(None),
            Err(error) => return Err(error),
        }
        // During rollout a pre-lock app may already own server.json. A live or
        // inaccessible PID is not proof of retirement, even if its API is down.
        let instance = Self {
            channel,
            _lock: lock,
        };
        if legacy_owner_may_be_running(&instance.channel)? {
            return Ok(None);
        }
        Ok(Some(instance))
    }
}

pub(crate) fn claim_startup(channel: AppChannel) -> io::Result<Option<&'static AppInstance>> {
    let Some(instance) = AppInstance::acquire(channel)? else {
        return Ok(None);
    };
    INSTANCE
        .set(instance)
        .map_err(|_| io::Error::other("app_instance_already_initialized"))?;
    Ok(INSTANCE.get())
}

pub(crate) fn current() -> Result<&'static AppInstance, String> {
    INSTANCE
        .get()
        .ok_or_else(|| "app_instance_not_owned".to_string())
}

fn legacy_owner_may_be_running(channel: &AppChannel) -> io::Result<bool> {
    let path = channel.control_dir.join("server.json");
    match path.symlink_metadata() {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Ok(metadata) if metadata.is_file() && metadata.len() <= MAX_DESCRIPTOR_BYTES => {}
        _ => return Err(io::Error::other("app_instance_descriptor_unavailable")),
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let mut contents = Vec::new();
    options
        .open(path)?
        .take(MAX_DESCRIPTOR_BYTES + 1)
        .read_to_end(&mut contents)?;
    if contents.len() as u64 > MAX_DESCRIPTOR_BYTES {
        return Err(io::Error::other("app_instance_descriptor_invalid"));
    }
    let descriptor: serde_json::Value = serde_json::from_slice(&contents)
        .map_err(|_| io::Error::other("app_instance_descriptor_invalid"))?;
    let pid = descriptor
        .get("processId")
        .and_then(|value| value.as_u64())
        .and_then(|value| u32::try_from(value).ok())
        .filter(|pid| *pid != 0)
        .ok_or_else(|| io::Error::other("app_instance_descriptor_invalid"))?;
    if descriptor
        .get("schemaVersion")
        .and_then(|value| value.as_u64())
        != Some(1)
        || descriptor.get("channel").and_then(|value| value.as_str()) != Some(&channel.name)
    {
        return Err(io::Error::other("app_instance_descriptor_invalid"));
    }
    match descriptor
        .get("appInstanceLockVersion")
        .and_then(|value| value.as_u64())
    {
        // The acquired kernel lock proves retirement of a cooperating owner,
        // including a crash followed by PID reuse. No TTL or PID file authority.
        Some(version) if version == u64::from(LOCK_VERSION) => Ok(false),
        Some(_) => Err(io::Error::other("app_instance_lock_version_unsupported")),
        None if pid == std::process::id() || crate::process_liveness::definitely_dead(pid) => {
            // This process has not started services yet. An exec handoff or
            // reused self PID cannot designate another incumbent process.
            Ok(false)
        }
        None if authenticated_legacy_owner(&descriptor, channel) => Ok(true),
        None => Err(io::Error::other("app_instance_legacy_owner_unverified")),
    }
}

fn authenticated_legacy_owner(descriptor: &serde_json::Value, channel: &AppChannel) -> bool {
    use std::time::Duration;
    let Some(port) = descriptor
        .get("port")
        .and_then(|value| value.as_u64())
        .and_then(|value| u16::try_from(value).ok())
        .filter(|port| *port > 0)
    else {
        return false;
    };
    let Some(token) = descriptor
        .get("token")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty() && value.len() <= 512)
    else {
        return false;
    };
    if !descriptor
        .get("generation")
        .and_then(|value| value.as_str())
        .is_some_and(|value| !value.is_empty() && value.len() <= 256)
        || descriptor
            .get("startedAtUnixMs")
            .and_then(|value| value.as_u64())
            .is_none()
    {
        return false;
    }
    // Fixed loopback destination; no proxy, redirects, focus request or repair.
    // A failed probe stays unknown and cannot retire an inaccessible/live PID.
    let probe = || -> Option<serde_json::Value> {
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_millis(250))
            .timeout(Duration::from_millis(500))
            .build()
            .ok()?;
        let response = client
            .get(format!("http://127.0.0.1:{port}/ping"))
            .bearer_auth(token)
            .send()
            .ok()?;
        if response.status() != reqwest::StatusCode::OK {
            return None;
        }
        let mut bytes = Vec::new();
        response
            .take(MAX_DESCRIPTOR_BYTES + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.len() as u64 > MAX_DESCRIPTOR_BYTES {
            return None;
        }
        serde_json::from_slice(&bytes).ok()
    };
    probe().is_some_and(|reply| {
        reply.get("ok").and_then(|value| value.as_bool()) == Some(true)
            && reply.get("channel").and_then(|value| value.as_str()) == Some(&channel.name)
            && ["generation", "processId", "startedAtUnixMs"]
                .iter()
                .all(|field| reply.get(field) == descriptor.get(field))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::path::Path;
    use std::process::{Child, Command, Stdio};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    fn channel(root: &Path, name: &str) -> AppChannel {
        let control_dir = crate::app_channel::control_dir_for(root, name);
        std::fs::create_dir_all(&control_dir).unwrap();
        AppChannel {
            name: name.into(),
            app_root: root.into(),
            control_dir,
        }
    }

    fn descriptor(channel: &AppChannel, pid: u32, guarded: bool) {
        let mut value = serde_json::json!({
            "schemaVersion": 1, "channel": channel.name, "processId": pid,
            "token": "fixture-token-never-log",
        });
        if guarded {
            value["appInstanceLockVersion"] = LOCK_VERSION.into();
        }
        std::fs::write(channel.control_dir.join("server.json"), value.to_string()).unwrap();
    }

    struct OwnedChild {
        child: Child,
        lines: mpsc::Receiver<String>,
    }

    impl OwnedChild {
        fn start(root: &Path) -> Self {
            std::fs::create_dir_all(root.join("home")).unwrap();
            let mut child = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--ignored",
                    "--exact",
                    "app_instance::tests::child_owner",
                    "--nocapture",
                ])
                .env("DURE_TEST_APP_INSTANCE_ROOT", root)
                .env("HOME", root.join("home"))
                .env("DURE_HOME", root)
                .env("HMUX_DISCOVERY_ROOT", root.join("hmux-discovery"))
                .env("DURE_APP_CHANNEL", "stable")
                .env_remove("HEBBIAN_APP_CHANNEL")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap();
            let stdout = child.stdout.take().unwrap();
            let (sender, lines) = mpsc::channel();
            std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    if sender.send(line.unwrap()).is_err() {
                        break;
                    }
                }
            });
            let result = Self { child, lines };
            assert_eq!(result.receipt(), "WAIT");
            result
        }

        fn send(&mut self, command: &str) {
            writeln!(self.child.stdin.as_mut().unwrap(), "{command}").unwrap();
        }

        fn receipt(&self) -> String {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let line = self
                    .lines
                    .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    .expect("ownership fixture did not respond within five seconds");
                if let Some((_, value)) = line.split_once("APP_INSTANCE ") {
                    return value.to_string();
                }
            }
        }
    }

    impl Drop for OwnedChild {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    #[test]
    #[ignore = "subprocess fixture; exercised by parent tests"]
    fn child_owner() {
        let root = std::env::var_os("DURE_TEST_APP_INSTANCE_ROOT").unwrap();
        println!("APP_INSTANCE WAIT");
        let mut input = String::new();
        if std::io::stdin().read_line(&mut input).unwrap() == 0 {
            return;
        }
        assert_eq!(input.trim(), "claim");
        let selected = crate::app_channel::current_for_bundle("io.hebbian.ade").unwrap();
        assert_eq!(selected, crate::app_channel::current().unwrap());
        assert_eq!(selected.control_dir, Path::new(&root));
        let Some(instance) = claim_startup(selected).unwrap() else {
            println!("APP_INSTANCE BUSY");
            return;
        };
        assert_eq!(current().unwrap().channel(), instance.channel());
        descriptor(instance.channel(), std::process::id(), true);
        std::fs::write(instance.channel().control_dir.join("hook-canary"), "owner").unwrap();
        println!("APP_INSTANCE OWNED");
        input.clear();
        std::io::stdin().read_line(&mut input).unwrap();
        assert_eq!(input.trim(), "exit");
    }

    #[test]
    fn simultaneous_processes_have_one_publisher_and_crash_releases_ownership() {
        let root = tempfile::tempdir().unwrap();
        let mut first = OwnedChild::start(root.path());
        let mut second = OwnedChild::start(root.path());
        first.send("claim");
        second.send("claim");
        let first_result = first.receipt();
        let second_result = second.receipt();
        assert!(matches!(
            (first_result.as_str(), second_result.as_str()),
            ("OWNED", "BUSY") | ("BUSY", "OWNED")
        ));
        let owned_channel = channel(root.path(), "stable");
        let published = std::fs::read(owned_channel.control_dir.join("server.json")).unwrap();
        assert!(AppInstance::acquire(owned_channel.clone())
            .unwrap()
            .is_none());
        assert_eq!(
            std::fs::read(owned_channel.control_dir.join("server.json")).unwrap(),
            published
        );
        assert_eq!(
            std::fs::read(owned_channel.control_dir.join("hook-canary")).unwrap(),
            b"owner"
        );
        let owner = if first_result == "OWNED" {
            &mut first
        } else {
            &mut second
        };
        owner.child.kill().unwrap();
        owner.child.wait().unwrap();
        // Simulate PID reuse in the old descriptor. The free kernel lock,
        // not that reused PID, establishes retirement of a cooperating owner.
        descriptor(&owned_channel, std::process::id(), true);
        let successor = AppInstance::acquire(owned_channel).unwrap().unwrap();
        assert_eq!(successor.channel().name, "stable");
    }

    #[test]
    fn channels_and_app_roots_are_independent_and_drop_keeps_the_lock_inode() {
        let root = tempfile::tempdir().unwrap();
        let another_root = tempfile::tempdir().unwrap();
        let stable = channel(root.path(), "stable");
        let first = AppInstance::acquire(stable.clone()).unwrap().unwrap();
        let _dev = AppInstance::acquire(channel(root.path(), "dev-fixture"))
            .unwrap()
            .unwrap();
        let _other = AppInstance::acquire(channel(another_root.path(), "stable"))
            .unwrap()
            .unwrap();
        assert!(AppInstance::acquire(stable.clone()).unwrap().is_none());
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            assert_ne!(
                unsafe { libc::fcntl(first._lock.as_raw_fd(), libc::F_GETFD) } & libc::FD_CLOEXEC,
                0
            );
        }
        drop(first);
        assert!(stable.control_dir.join(LOCK_FILE).is_file());
        assert!(AppInstance::acquire(stable).unwrap().is_some());
    }

    #[test]
    fn live_legacy_owner_is_preserved_without_writing_descriptors_or_hooks() {
        for mismatch in [
            None,
            Some("generation"),
            Some("processId"),
            Some("startedAtUnixMs"),
            Some("channel"),
        ] {
            let root = tempfile::tempdir().unwrap();
            let previous = OwnedChild::start(root.path());
            let stable = channel(root.path(), "stable");
            let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let value = serde_json::json!({
                "schemaVersion": 1, "processId": previous.child.id(), "channel": "stable",
                "port": listener.local_addr().unwrap().port(), "token": "fixture-auth",
                "generation": "fixture-generation", "startedAtUnixMs": 1234,
            });
            std::fs::write(stable.control_dir.join("server.json"), value.to_string()).unwrap();
            let server = std::thread::spawn(move || {
                listener.set_nonblocking(true).unwrap();
                let deadline = Instant::now() + Duration::from_secs(2);
                let (mut socket, _) = loop {
                    match listener.accept() {
                        Ok(connection) => break connection,
                        Err(error)
                            if error.kind() == io::ErrorKind::WouldBlock
                                && Instant::now() < deadline =>
                        {
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(error) => panic!("legacy probe did not connect: {error}"),
                    }
                };
                // macOS may inherit the listener's nonblocking flag. Header
                // reads need to wait for bytes under the existing timeout.
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut reader = BufReader::new(socket.try_clone().unwrap());
                let mut headers = String::new();
                loop {
                    let mut line = String::new();
                    assert!(reader.read_line(&mut line).unwrap() > 0);
                    assert!(headers.len() + line.len() < 8192);
                    if line == "\r\n" {
                        break;
                    }
                    headers.push_str(&line);
                }
                assert!(headers.starts_with("GET /ping HTTP/1.1"));
                assert!(headers
                    .to_ascii_lowercase()
                    .contains("authorization: bearer fixture-auth"));
                let mut reply = value;
                reply["ok"] = true.into();
                if let Some(field) = mismatch {
                    reply[field] = serde_json::Value::Null;
                }
                let body = reply.to_string();
                write!(
                    socket,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            });
            let descriptor_path = stable.control_dir.join("server.json");
            let before = std::fs::read(&descriptor_path).unwrap();
            let hook = stable.control_dir.join("hook-canary");
            std::fs::write(&hook, "legacy owner").unwrap();
            let result = AppInstance::acquire(stable);
            if mismatch.is_some() {
                assert!(
                    result.is_err(),
                    "mismatched legacy identity must remain unknown"
                );
            } else {
                assert!(result.unwrap().is_none());
            }
            server.join().unwrap();
            assert_eq!(std::fs::read(descriptor_path).unwrap(), before);
            assert_eq!(std::fs::read(hook).unwrap(), b"legacy owner");
        }
    }

    #[test]
    fn unreachable_legacy_owner_is_unknown_and_self_pid_handoff_is_not_an_incumbent() {
        let root = tempfile::tempdir().unwrap();
        let previous = OwnedChild::start(root.path());
        let stable = channel(root.path(), "stable");
        descriptor(&stable, previous.child.id(), false);
        assert!(AppInstance::acquire(stable.clone()).is_err());
        descriptor(&stable, std::process::id(), false);
        assert!(AppInstance::acquire(stable).unwrap().is_some());
    }

    #[test]
    fn proven_exited_legacy_owner_allows_startup() {
        let root = tempfile::tempdir().unwrap();
        let mut previous = OwnedChild::start(root.path());
        let pid = previous.child.id();
        previous.child.kill().unwrap();
        previous.child.wait().unwrap();
        let stable = channel(root.path(), "stable");
        descriptor(&stable, pid, false);
        assert!(crate::process_liveness::definitely_dead(pid));
        assert!(AppInstance::acquire(stable).unwrap().is_some());
    }

    #[test]
    fn invalid_or_oversized_descriptor_fails_closed_without_mutation() {
        let root = tempfile::tempdir().unwrap();
        let stable = channel(root.path(), "stable");
        let path = stable.control_dir.join("server.json");
        for contents in [
            b"{invalid".to_vec(),
            vec![b' '; MAX_DESCRIPTOR_BYTES as usize + 1],
        ] {
            std::fs::write(&path, &contents).unwrap();
            assert!(AppInstance::acquire(stable.clone()).is_err());
            assert_eq!(std::fs::read(&path).unwrap(), contents);
        }
        descriptor(&stable, std::process::id(), true);
        assert!(AppInstance::acquire(stable).unwrap().is_some());
    }

    #[cfg(unix)]
    #[test]
    fn lock_symlinks_are_never_followed() {
        let root = tempfile::tempdir().unwrap();
        let stable = channel(root.path(), "stable");
        let untouched = root.path().join("unrelated");
        std::fs::write(&untouched, "preserved").unwrap();
        std::os::unix::fs::symlink(&untouched, stable.control_dir.join(LOCK_FILE)).unwrap();
        assert!(AppInstance::acquire(stable).is_err());
        assert_eq!(std::fs::read(untouched).unwrap(), b"preserved");
    }
}
