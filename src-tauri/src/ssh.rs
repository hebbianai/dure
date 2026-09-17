use std::{
    collections::{HashMap, HashSet},
    io::{self, Read, Write},
    net::TcpStream,
    ops::Deref,
    path::Path,
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ssh2::Session;

use crate::secrets;
use base64::Engine;

mod exec;
pub(crate) mod target;
pub(crate) mod host_location;
pub mod directory;

const OPENSSH_HOST_KEY_PREFERENCE: &str = concat!(
    "ssh-ed25519,ecdsa-sha2-nistp256,ecdsa-sha2-nistp384,",
    "ecdsa-sha2-nistp521,rsa-sha2-512,rsa-sha2-256"
);
const MAX_EXEC_COMMAND_BYTES: usize = 65_536;
const MAX_EXEC_STDIN_BYTES: usize = 8_470_528;
const MAX_EXEC_COMBINED_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
const EXEC_TIMEOUT: Duration = Duration::from_secs(20);
/// How long an authenticated session may sit unused before it is closed
/// rather than reused. Long enough to cover a poller cadence, short enough
/// that a box which silently went away is not trusted for long.
const POOL_IDLE_TTL: Duration = Duration::from_secs(90);
/// Idle sessions kept per target. Concurrent callers each get their own
/// session; anything beyond this is closed on release instead of parked.
const POOL_MAX_IDLE_PER_TARGET: usize = 3;

pub(crate) fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn home_directory() -> Option<String> {
    #[cfg(windows)]
    {
        dirs::home_dir().map(|path| path.to_string_lossy().into_owned())
    }
    #[cfg(not(windows))]
    {
        std::env::var("HOME").ok()
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshOptions {
    pub host: String,
    pub port: Option<u16>,
    pub user: String,
    /// "auto" (agent + default keys) | "password" | "key"
    pub auth: Option<String>,
    /// OS credential store account. `password` is only a legacy migration
    /// fallback and is never written by current frontends.
    pub secret_id: Option<String>,
    pub password: Option<String>,
    pub key_path: Option<String>,
    pub passphrase: Option<String>,
    #[serde(default)]
    pub host_key_fingerprints: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct ExecResult {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

/// libssh2/Path::new는 `~`나 `$HOME`을 확장하지 않는다. 사용자가 입력한
/// 키 경로(예: `~/.ssh/id_ed25519`)를 실제 절대 경로로 펼친다.
fn expand_path(p: &str) -> std::path::PathBuf {
    let p = p.trim();
    let home = home_directory();
    let expanded = if p == "~" {
        home.clone().unwrap_or_else(|| p.to_string())
    } else if let Some(rest) = p.strip_prefix("~/") {
        match &home {
            Some(h) => format!("{h}/{rest}"),
            None => p.to_string(),
        }
    } else if let Some(rest) = p.strip_prefix("$HOME/") {
        match &home {
            Some(h) => format!("{h}/{rest}"),
            None => p.to_string(),
        }
    } else {
        p.to_string()
    };
    std::path::PathBuf::from(expanded)
}

pub(crate) fn connect(opts: &SshOptions) -> Result<Session, String> {
    let addr = format!("{}:{}", opts.host, opts.port.unwrap_or(22));
    let tcp = TcpStream::connect_timeout(
        &addr
            .parse()
            .or_else(|_| {
                use std::net::ToSocketAddrs;
                addr.to_socket_addrs()
                    .map_err(|e| format!("resolve {addr}: {e}"))?
                    .next()
                    .ok_or_else(|| format!("resolve {addr}: no address"))
            })
            .map_err(|e: String| e)?,
        Duration::from_secs(10),
    )
    .map_err(|e| format!("connect {addr}: {e}"))?;
    tcp.set_nodelay(true).ok();

    let mut sess = Session::new().map_err(|e| e.to_string())?;
    sess.method_pref(ssh2::MethodType::HostKey, OPENSSH_HOST_KEY_PREFERENCE)
        .map_err(|e| format!("host key preference: {e}"))?;
    sess.set_tcp_stream(tcp);
    sess.set_timeout(20_000);
    sess.handshake().map_err(|e| format!("handshake: {e}"))?;

    if !opts.host_key_fingerprints.is_empty() {
        let (key, _) = sess
            .host_key()
            .ok_or_else(|| "ssh host key is unavailable after handshake".to_string())?;
        let fingerprint = host_key_fingerprint(key);
        if !opts.host_key_fingerprints.contains(&fingerprint) {
            return Err(format!("ssh host key rejected: {fingerprint} is not registered"));
        }
    }

    let user = &opts.user;
    match opts.auth.as_deref().unwrap_or("auto") {
        "password" => {
            let stored_password;
            let password = if let Some(password) = opts.password.as_deref() {
                password
            } else if let Some(secret_id) = opts.secret_id.as_deref() {
                stored_password = secrets::get_ssh_secret(secret_id)?.ok_or_else(|| {
                    "password auth: could not find the saved password".to_string()
                })?;
                &stored_password
            } else {
                return Err("password auth: no saved password is available".into());
            };
            sess.userauth_password(user, password)
                .map_err(|e| format!("password auth: {e}"))?
        }
        "key" => {
            let raw = opts.key_path.as_deref().unwrap_or("").trim();
            if raw.is_empty() {
                return Err("key auth: the private key path is empty".into());
            }
            let key = expand_path(raw);
            if !key.exists() {
                return Err(format!(
                    "key auth: private key file not found: {}",
                    key.display()
                ));
            }
            // 공개키(.pub)가 있으면 명시적으로 함께 넘긴다 — libssh2가 파생에
            // 실패하는 백엔드 대비. 없으면 None(개인키에서 파생).
            let pub_key = key.with_extension("pub");
            let pub_ref = if pub_key.exists() { Some(pub_key.as_path()) } else { None };
            sess.userauth_pubkey_file(user, pub_ref, &key, opts.passphrase.as_deref())
                .map_err(|e| format!("key auth ({}): {e}", key.display()))?
        }
        _ => {
            let mut tried: Vec<String> = Vec::new();
            // "none" auth first — Tailscale SSH and similar setups accept it.
            // Querying the auth method list performs the none-auth attempt.
            let auth_list = sess.auth_methods(user).map(|m| m.to_string());
            if !sess.authenticated() {
                match &auth_list {
                    Ok(m) => tried.push(format!("none (server allows: {m})")),
                    Err(e) => tried.push(format!("none ({e})")),
                }
                match sess.userauth_agent(user) {
                    Ok(()) => {}
                    Err(e) => tried.push(format!("ssh-agent ({e})")),
                }
            }
            if !sess.authenticated() {
                let home = home_directory().unwrap_or_default();
                for k in ["id_ed25519", "id_rsa", "id_ecdsa"] {
                    let p = format!("{home}/.ssh/{k}");
                    if !Path::new(&p).exists() {
                        continue;
                    }
                    match sess.userauth_pubkey_file(user, None, Path::new(&p), None) {
                        Ok(()) => break,
                        Err(e) => tried.push(format!("{k} ({e})")),
                    }
                }
            }
            if !sess.authenticated() {
                let joined = tried.join("; ");
                let hint = if joined.contains("Waiting for USERAUTH")
                    || joined.contains("Failed getting response")
                {
                    "\nHint: the server disconnected during authentication. Check that the username exactly matches the remote account (case-sensitive)."
                } else {
                    ""
                };
                return Err(format!("Authentication failed for '{user}'; attempted: {joined}{hint}"));
            }
        }
    }
    if !sess.authenticated() {
        return Err("authentication failed".into());
    }
    sess.set_keepalive(true, 15);
    Ok(sess)
}

fn host_key_fingerprint(key: &[u8]) -> String {
    format!(
        "SHA256:{}",
        base64::engine::general_purpose::STANDARD_NO_PAD.encode(Sha256::digest(key))
    )
}

/// One-shot SSH work (a git status, a directory listing, an installer step)
/// used to pay a TCP connect, a key exchange and an authentication chain per
/// call, and a workspace with a few pollers and a few panes made dozens of
/// such calls per minute. Authenticated sessions are parked here between
/// calls instead, keyed by everything that decides who the session is.
///
/// Secrets are not part of the key: a session already authenticated is the
/// proof, and a changed password only matters for the next fresh connection.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct PoolKey {
    host: String,
    port: u16,
    user: String,
    auth: String,
    secret_id: Option<String>,
    key_path: Option<String>,
    host_key_fingerprints: Vec<String>,
}

impl PoolKey {
    fn of(opts: &SshOptions) -> Self {
        let mut host_key_fingerprints = opts.host_key_fingerprints.clone();
        host_key_fingerprints.sort();
        Self {
            host: opts.host.clone(),
            port: opts.port.unwrap_or(22),
            user: opts.user.clone(),
            auth: opts.auth.clone().unwrap_or_else(|| "auto".to_string()),
            secret_id: opts.secret_id.clone(),
            key_path: opts.key_path.clone(),
            host_key_fingerprints,
        }
    }
}

struct IdleSession {
    session: Session,
    parked_at: Instant,
}

static POOL: Mutex<Option<HashMap<PoolKey, Vec<IdleSession>>>> = Mutex::new(None);

/// Sessions whose transport failed under a caller that only holds
/// `&Session` (every `exec_on`/`upload_on` user). Keyed by the libssh2
/// session pointer, which is stable for the session's life; the entry is
/// consumed when the owning [`PooledSession`] is released.
static BROKEN: Mutex<Option<HashSet<usize>>> = Mutex::new(None);

fn session_identity(sess: &Session) -> usize {
    std::ptr::from_ref(&*sess.raw()) as usize
}

fn mark_broken(sess: &Session) {
    let mut guard = match BROKEN.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    guard
        .get_or_insert_with(HashSet::new)
        .insert(session_identity(sess));
}

fn take_broken(sess: &Session) -> bool {
    let mut guard = match BROKEN.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    guard
        .as_mut()
        .is_some_and(|broken| broken.remove(&session_identity(sess)))
}

/// libssh2 session error codes (libssh2.h) that mean the transport itself is
/// unusable, as opposed to a remote answer such as an SFTP miss or a refused
/// channel. The `ssh2` crate does not re-export the constants.
const LIBSSH2_TRANSPORT_ERRORS: [i32; 9] = [
    -7,  // LIBSSH2_ERROR_SOCKET_SEND
    -8,  // LIBSSH2_ERROR_KEY_EXCHANGE_FAILURE
    -9,  // LIBSSH2_ERROR_TIMEOUT
    -12, // LIBSSH2_ERROR_DECRYPT
    -13, // LIBSSH2_ERROR_SOCKET_DISCONNECT
    -14, // LIBSSH2_ERROR_PROTO
    -30, // LIBSSH2_ERROR_SOCKET_TIMEOUT
    -39, // LIBSSH2_ERROR_BAD_USE
    -43, // LIBSSH2_ERROR_SOCKET_RECV
];

fn transport_failed(sess: &Session) -> bool {
    match ssh2::Error::last_session_error(sess).map(|error| error.code()) {
        Some(ssh2::ErrorCode::Session(code)) => LIBSSH2_TRANSPORT_ERRORS.contains(&code),
        _ => false,
    }
}

fn with_pool<T>(f: impl FnOnce(&mut HashMap<PoolKey, Vec<IdleSession>>) -> T) -> T {
    let mut guard = match POOL.lock() {
        Ok(guard) => guard,
        // A panic while holding the pool lock loses at most parked sessions.
        Err(poisoned) => poisoned.into_inner(),
    };
    let pool = guard.get_or_insert_with(HashMap::new);
    let now = Instant::now();
    pool.retain(|_, idle| {
        idle.retain(|entry| now.duration_since(entry.parked_at) < POOL_IDLE_TTL);
        !idle.is_empty()
    });
    f(pool)
}

fn take_idle(key: &PoolKey) -> Option<Session> {
    with_pool(|pool| pool.get_mut(key).and_then(Vec::pop).map(|entry| entry.session))
}

fn park(key: PoolKey, session: Session) {
    with_pool(|pool| {
        let idle = pool.entry(key).or_default();
        if idle.len() < POOL_MAX_IDLE_PER_TARGET {
            idle.push(IdleSession {
                session,
                parked_at: Instant::now(),
            });
        }
    });
}

/// An authenticated session on loan from the pool. Dropping it parks the
/// session for the next caller unless the transport proved broken.
pub(crate) struct PooledSession {
    session: Option<Session>,
    key: PoolKey,
    /// Whether this session was parked before: a failure on a reused session
    /// may be staleness rather than the remote's answer, and is retried once
    /// on a fresh connection when nothing has been executed yet.
    reused: bool,
    broken: bool,
}

impl PooledSession {
    fn fresh(key: PoolKey, session: Session) -> Self {
        Self {
            session: Some(session),
            key,
            reused: false,
            broken: false,
        }
    }

    /// Whether this session was parked before rather than opened for this call.
    pub(crate) fn is_reused(&self) -> bool {
        self.reused
    }

    /// Mark the transport unusable; the session is closed instead of parked.
    pub(crate) fn poison(&mut self) {
        self.broken = true;
    }

    fn session(&self) -> &Session {
        self.session
            .as_ref()
            .expect("a pooled session is present until drop")
    }
}

impl Deref for PooledSession {
    type Target = Session;

    fn deref(&self) -> &Session {
        self.session()
    }
}

impl Drop for PooledSession {
    fn drop(&mut self) {
        let Some(session) = self.session.take() else {
            return;
        };
        session.set_blocking(true);
        // Discarded rather than parked: anything this loan poisoned, anything
        // an `exec_on`/`upload_on` under it marked broken, and anything whose
        // last libssh2 error was the socket itself. A session the peer
        // dropped silently shows up as a timeout on its next use, which is
        // all of those, so it is not handed out a third time.
        let broken = take_broken(&session);
        if self.broken || broken || transport_failed(&session) {
            return;
        }
        park(self.key.clone(), session);
    }
}

/// An authenticated session for one bounded piece of work: a parked one for
/// this target when there is one, otherwise a new connection.
pub(crate) fn acquire(opts: &SshOptions) -> Result<PooledSession, String> {
    let key = PoolKey::of(opts);
    if let Some(session) = take_idle(&key) {
        return Ok(PooledSession {
            session: Some(session),
            key,
            reused: true,
            broken: false,
        });
    }
    let session = connect(opts)?;
    Ok(PooledSession::fresh(key, session))
}

/// A new connection for this target, bypassing anything parked. For work that
/// hands the session to something that owns it beyond one call.
pub(crate) fn acquire_fresh(opts: &SshOptions) -> Result<PooledSession, String> {
    let key = PoolKey::of(opts);
    let session = connect(opts)?;
    Ok(PooledSession::fresh(key, session))
}

/// Run `work` on a pooled session. When a reused session fails before the
/// work reached the remote (its socket went away while parked), the work is
/// retried once on a fresh connection; a failure after that is the answer.
pub(crate) fn with_session<T>(
    opts: &SshOptions,
    mut work: impl FnMut(&Session) -> Result<T, Attempt>,
) -> Result<T, String> {
    let mut session = acquire(opts)?;
    match work(&session) {
        Ok(value) => Ok(value),
        Err(Attempt::Started(error)) => {
            session.poison();
            Err(error)
        }
        Err(Attempt::NotStarted(error)) => {
            session.poison();
            let reused = session.is_reused();
            drop(session);
            if !reused {
                return Err(error);
            }
            let mut session = acquire_fresh(opts)?;
            match work(&session) {
                Ok(value) => Ok(value),
                Err(Attempt::Started(error)) | Err(Attempt::NotStarted(error)) => {
                    session.poison();
                    Err(error)
                }
            }
        }
    }
}

/// How far a piece of pooled work got before it failed.
pub(crate) enum Attempt {
    /// Nothing reached the remote; the same work can run again elsewhere.
    NotStarted(String),
    /// The remote may have acted; the failure is final.
    Started(String),
}

struct SshExecChannel {
    channel: ssh2::Channel,
}

struct SessionBlockingGuard<'a>(&'a Session);

impl<'a> SessionBlockingGuard<'a> {
    fn nonblocking(session: &'a Session) -> Self {
        session.set_blocking(false);
        Self(session)
    }
}

impl Drop for SessionBlockingGuard<'_> {
    fn drop(&mut self) {
        self.0.set_blocking(true);
    }
}

fn io_step<T>(result: io::Result<T>) -> Result<exec::Step<T>, String> {
    match result {
        Ok(value) => Ok(exec::Step::Ready(value)),
        Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok(exec::Step::Pending),
        Err(error) => Err(error.to_string()),
    }
}

fn ssh_step<T>(result: Result<T, ssh2::Error>) -> Result<exec::Step<T>, String> {
    io_step(result.map_err(io::Error::from))
}

impl exec::Channel for SshExecChannel {
    fn write_stdin(&mut self, bytes: &[u8]) -> Result<exec::Step<usize>, String> {
        io_step(self.channel.write(bytes))
    }

    fn send_eof(&mut self) -> Result<exec::Step<()>, String> {
        ssh_step(self.channel.send_eof())
    }

    fn read_stdout(&mut self, bytes: &mut [u8]) -> Result<exec::Step<usize>, String> {
        io_step(self.channel.read(bytes))
    }

    fn read_stderr(&mut self, bytes: &mut [u8]) -> Result<exec::Step<usize>, String> {
        io_step(self.channel.stderr().read(bytes))
    }

    fn close(&mut self) -> Result<exec::Step<()>, String> {
        ssh_step(self.channel.close())
    }

    fn wait_close(&mut self) -> Result<exec::Step<()>, String> {
        ssh_step(self.channel.wait_close())
    }

    fn exit_status(&self) -> i32 {
        self.channel.exit_status().unwrap_or(-1)
    }
}

fn validate_exec_payload<'a>(cmd: &str, stdin: Option<&'a str>) -> Result<Option<&'a [u8]>, String> {
    if cmd.len() > MAX_EXEC_COMMAND_BYTES {
        return Err("ssh_exec_command_too_large".to_string());
    }
    let stdin = stdin.map(str::as_bytes);
    if stdin.is_some_and(|bytes| bytes.len() > MAX_EXEC_STDIN_BYTES) {
        return Err("ssh_exec_stdin_too_large".to_string());
    }
    Ok(stdin)
}

fn open_exec_channel(sess: &Session, cmd: &str) -> Result<ssh2::Channel, String> {
    let mut channel = sess.channel_session().map_err(|e| e.to_string())?;
    channel.exec(cmd).map_err(|e| e.to_string())?;
    Ok(channel)
}

fn drive_exec_channel(
    sess: &Session,
    channel: ssh2::Channel,
    stdin: Option<&[u8]>,
    timeout: Duration,
) -> Result<ExecResult, String> {
    let output = {
        let _blocking = SessionBlockingGuard::nonblocking(sess);
        let mut channel = SshExecChannel { channel };
        exec::execute(
            &mut channel,
            stdin.unwrap_or_default(),
            MAX_EXEC_COMBINED_OUTPUT_BYTES,
            Instant::now() + timeout,
        )
    }?;
    Ok(ExecResult {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        code: output.code,
    })
}

fn exec_on_with_stdin(
    sess: &Session,
    cmd: &str,
    stdin: Option<&[u8]>,
    timeout: Duration,
) -> Result<ExecResult, String> {
    let result = open_exec_channel(sess, cmd)
        .and_then(|channel| drive_exec_channel(sess, channel, stdin, timeout));
    if result.is_err() {
        // The caller only has `&Session`; a failed exchange (timeout,
        // socket, an unclosed channel left behind in non-blocking mode) must
        // still keep this session out of the pool.
        mark_broken(sess);
    }
    result
}

/// The same as [`exec_on_with_stdin`], distinguishing a failure to open the
/// exec channel (nothing ran) from a failure while the command was running.
fn exec_attempt(
    sess: &Session,
    cmd: &str,
    stdin: Option<&[u8]>,
    timeout: Duration,
) -> Result<ExecResult, Attempt> {
    let channel = open_exec_channel(sess, cmd).map_err(Attempt::NotStarted)?;
    drive_exec_channel(sess, channel, stdin, timeout).map_err(Attempt::Started)
}

pub(crate) fn exec_on(sess: &Session, cmd: &str) -> Result<ExecResult, String> {
    exec_on_with_stdin(sess, cmd, None, EXEC_TIMEOUT)
}

pub(crate) fn upload_on(sess: &Session, path: &str, data: &[u8]) -> Result<String, String> {
    match upload_attempt(sess, path, data) {
        Ok(path) => Ok(path),
        Err(Attempt::NotStarted(error)) | Err(Attempt::Started(error)) => {
            mark_broken(sess);
            Err(error)
        }
    }
}

fn upload_attempt(sess: &Session, path: &str, data: &[u8]) -> Result<String, Attempt> {
    let mut ch = sess
        .scp_send(Path::new(path), 0o644, data.len() as u64, None)
        .map_err(|e| Attempt::NotStarted(format!("scp: {e}")))?;
    ch.write_all(data)
        .map_err(|e| Attempt::Started(format!("scp write: {e}")))?;
    ch.send_eof().ok();
    ch.wait_eof().ok();
    ch.close().ok();
    ch.wait_close().ok();
    Ok(path.to_string())
}

/// Run a single command on a pooled connection (project browsing, remote git
/// status, worktree creation). The connection outlives the call.
pub fn exec_once(opts: &SshOptions, cmd: &str) -> Result<ExecResult, String> {
    exec_once_with_timeout(opts, cmd, EXEC_TIMEOUT)
}

pub(crate) fn exec_once_with_timeout(
    opts: &SshOptions,
    cmd: &str,
    timeout: Duration,
) -> Result<ExecResult, String> {
    validate_exec_payload(cmd, None)?;
    with_session(opts, |sess| exec_attempt(sess, cmd, None, timeout))
}

pub fn exec_once_with_stdin(
    opts: &SshOptions,
    cmd: &str,
    stdin: Option<&str>,
) -> Result<ExecResult, String> {
    let stdin = validate_exec_payload(cmd, stdin)?;
    with_session(opts, |sess| exec_attempt(sess, cmd, stdin, EXEC_TIMEOUT))
}

#[cfg(not(windows))]
pub(crate) fn exec_on_with_stdin_timeout(
    sess: &Session,
    cmd: &str,
    stdin: Option<&str>,
    timeout: Duration,
) -> Result<ExecResult, String> {
    let stdin = validate_exec_payload(cmd, stdin)?;
    exec_on_with_stdin(sess, cmd, stdin, timeout)
}

/// Upload one file (scp) on a pooled connection. path는 원격 홈 기준 상대경로.
/// 세션 데몬 바이너리 배포용.
pub fn upload_once(opts: &SshOptions, path: &str, data: Vec<u8>) -> Result<String, String> {
    with_session(opts, |sess| upload_attempt(sess, path, &data))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mirrors_openssh_plain_host_key_preference() {
        assert!(OPENSSH_HOST_KEY_PREFERENCE.starts_with("ssh-ed25519,"));
    }

    #[test]
    fn transient_nonblocking_io_remains_pending() {
        let pending = io_step::<usize>(Err(io::ErrorKind::WouldBlock.into())).unwrap();

        assert!(matches!(pending, exec::Step::Pending));
    }

    #[test]
    fn exec_payload_refuses_oversize_values_before_connection() {
        let command = "x".repeat(MAX_EXEC_COMMAND_BYTES + 1);
        let stdin = "x".repeat(MAX_EXEC_STDIN_BYTES + 1);

        assert_eq!(
            validate_exec_payload(&command, None).unwrap_err(),
            "ssh_exec_command_too_large"
        );
        assert_eq!(
            validate_exec_payload("sh -s", Some(&stdin)).unwrap_err(),
            "ssh_exec_stdin_too_large"
        );
    }
}
