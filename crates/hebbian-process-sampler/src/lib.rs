#![forbid(unsafe_op_in_unsafe_fn)]

#[cfg(not(unix))]
compile_error!("hebbian-process-sampler requires Unix process and socket APIs");

use fs2::FileExt;
use hebbian_bounded_process::{CommandFailure, CommandSpec, run as run_bounded};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::os::unix::prelude::AsRawFd;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{TrySendError, sync_channel};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// The one authority on which sampler wire protocol this build speaks.
///
/// The socket file name and the frame framing are both derived from it, and
/// they must never again be able to disagree. They already did: three
/// installed builds on this machine bind `process-sampler-v{1,2,3}.sock` while
/// all three still speak the original `HPS1` framing, because the path version
/// and the magic lived in two independent constants and were bumped
/// separately. A client then meets a daemon that answers the connect, cannot
/// decode the frame, and closes — a version mismatch wearing the costume of a
/// transport hiccup.
const PROTOCOL_VERSION: u32 = 8;
const REQUEST_MAGIC: &[u8; 4] = b"HPSQ";
const RESPONSE_MAGIC: &[u8; 4] = b"HPSP";
/// Sent by the server the moment it accepts, before it reads anything.
///
/// A versioned path cannot keep an incompatible peer away — it can only be
/// squatted, as it has been here. So the transport carries its own proof, the
/// same argument `hmux-host`'s `peer_attestation` makes for the session
/// transport: the peer states what it serves, and a client that cannot be
/// served learns *that*, instead of an anonymous EOF it will misread as
/// "not yet, ask again".
const ATTESTATION_MAGIC: &[u8; 4] = b"HPSA";
const ATTESTATION_BYTES: usize = 8;
const REQUEST_BYTES: usize = 20;
const RESPONSE_HEADER_BYTES: usize = 12;
const REQUEST_AGENT: u8 = 1;
const REQUEST_SNAPSHOT: u8 = 2;
const REQUEST_FOREGROUND: u8 = 3;
const REQUEST_FRESH_SNAPSHOT: u8 = 4;
const REQUEST_COMPLETE_SNAPSHOT: u8 = 5;
const STATUS_NONE: u8 = 0;
const STATUS_AGENT: u8 = 1;
const STATUS_UNAVAILABLE: u8 = 2;
const STATUS_SNAPSHOT: u8 = 3;
const STATUS_FOREGROUND: u8 = 4;
const AGENT_PAYLOAD_BYTES: usize = 16;
const FOREGROUND_PAYLOAD_BYTES: usize = 16;
const MAX_PS_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
const MAX_PROCESS_RECORDS: usize = 131_072;
const MAX_COMMAND_BYTES: usize = 64 * 1024;
#[cfg(any(target_os = "macos", target_os = "linux"))]
const MAX_PROCESS_ARGUMENT_BYTES: usize = 1024 * 1024;
const MAX_RESPONSE_PAYLOAD_BYTES: usize =
    MAX_PS_OUTPUT_BYTES * 3 + MAX_PROCESS_RECORDS * 16 + std::mem::size_of::<u64>() + 4;
const DEFAULT_FRESHNESS: Duration = Duration::from_millis(500);
const PROCESS_SAMPLE_TIMEOUT: Duration = Duration::from_secs(1);
const COMPLETE_SNAPSHOT_WAIT_TIMEOUT: Duration = Duration::from_millis(1_500);
const MAX_COMPLETE_SNAPSHOT_AGE: Duration = Duration::from_millis(500);
const IO_TIMEOUT: Duration = Duration::from_secs(2);
/// The accept loop answers an overflowing queue itself, so the bound has to be
/// small enough that one unreadable client cannot stall accepting.
const OVERLOAD_REPLY_TIMEOUT: Duration = Duration::from_millis(50);
const MAX_SAMPLER_WORKERS: usize = 4;
const MAX_PENDING_CONNECTIONS: usize = 32;
/// Bound consecutive timeouts before serving locally between recovery probes.
const MAX_UNRESPONSIVE_ATTEMPTS: u32 = 3;
const PEER_RECOVERY_INTERVAL: Duration = Duration::from_secs(30);

/// Announced at most once per process — see `announce_local_fallback`.
static LOCAL_FALLBACK_ANNOUNCED: AtomicBool = AtomicBool::new(false);

/// 앱이 아는 에이전트 CLI. `as_str`은 앱의 `src/types.ts` Provider id와 같은 문자열이며,
/// 그 값이 그대로 프레임에 실려 UI의 로고·라벨로 이어진다.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentProvider {
    Claude,
    Codex,
    Kimi,
    Gemini,
    Cursor,
    Copilot,
    Opencode,
    Amp,
    Goose,
    Droid,
    Auggie,
    Grok,
    Hermes,
    QwenCode,
    Cline,
    Continue,
    Charm,
    Codebuff,
    Kilocode,
    Kiro,
    RovoDev,
    MistralVibe,
    Antigravity,
    Openclaude,
    Pi,
    OhMyPi,
    CommandCode,
}

impl AgentProvider {
    #[must_use]
    pub fn from_id(id: &str) -> Option<Self> {
        AGENT_BINARIES
            .iter()
            .map(|spec| spec.provider)
            .find(|provider| provider.as_str() == id)
    }

    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Kimi => "kimi",
            Self::Gemini => "gemini",
            Self::Cursor => "cursor",
            Self::Copilot => "copilot",
            Self::Opencode => "opencode",
            Self::Amp => "amp",
            Self::Goose => "goose",
            Self::Droid => "droid",
            Self::Auggie => "auggie",
            Self::Grok => "grok",
            Self::Hermes => "hermes",
            Self::QwenCode => "qwen-code",
            Self::Cline => "cline",
            Self::Continue => "continue",
            Self::Charm => "charm",
            Self::Codebuff => "codebuff",
            Self::Kilocode => "kilocode",
            Self::Kiro => "kiro",
            Self::RovoDev => "rovo-dev",
            Self::MistralVibe => "mistral-vibe",
            Self::Antigravity => "antigravity",
            Self::Openclaude => "openclaude",
            Self::Pi => "pi",
            Self::OhMyPi => "oh-my-pi",
            Self::CommandCode => "command-code",
        }
    }

    /// 프레임에 싣는 코드. 값은 영구적이다 — 기존 코드를 재사용하면 구버전 클라이언트가
    /// 다른 프로바이더로 읽는다. 새 프로바이더는 항상 뒤에 붙인다.
    fn wire_code(self) -> u8 {
        match self {
            Self::Claude => 1,
            Self::Codex => 2,
            Self::Kimi => 3,
            Self::Gemini => 4,
            Self::Cursor => 5,
            Self::Copilot => 6,
            Self::Opencode => 7,
            Self::Amp => 8,
            Self::Goose => 9,
            Self::Droid => 10,
            Self::Auggie => 11,
            Self::Grok => 12,
            Self::Hermes => 13,
            Self::QwenCode => 14,
            Self::Cline => 15,
            Self::Continue => 16,
            Self::Charm => 17,
            Self::Codebuff => 18,
            Self::Kilocode => 19,
            Self::Kiro => 20,
            Self::RovoDev => 21,
            Self::MistralVibe => 22,
            Self::Antigravity => 23,
            Self::Openclaude => 24,
            Self::Pi => 25,
            Self::OhMyPi => 26,
            Self::CommandCode => 27,
        }
    }

    /// 모르는 코드는 None — 구버전 데몬/클라이언트와 섞여도 엉뚱한 프로바이더로 읽지 않는다.
    fn from_wire_code(code: u8) -> Option<Self> {
        AGENT_BINARIES
            .iter()
            .map(|spec| spec.provider)
            .find(|provider| provider.wire_code() == code)
    }
}

/// 실행 파일 이름 → 프로바이더. 앱 `src/types.ts` PROVIDERS의
/// `cmd` 첫 낱말 + `detectNames`와 짝을 맞춘다(패키지 이름이 아니라 실제 실행 파일).
struct AgentBinary {
    provider: AgentProvider,
    name: &'static str,
    /// 에이전트 말고 다른 용도로도 쓰는 실행 파일은 이 토큰이 같이 있어야 에이전트로 본다.
    /// (`acli jira …`는 Rovo Dev가 아니다)
    requires: Option<&'static str>,
}

const fn binary(provider: AgentProvider, name: &'static str) -> AgentBinary {
    AgentBinary {
        provider,
        name,
        requires: None,
    }
}

const fn binary_with(
    provider: AgentProvider,
    name: &'static str,
    requires: &'static str,
) -> AgentBinary {
    AgentBinary {
        provider,
        name,
        requires: Some(requires),
    }
}

const AGENT_BINARIES: &[AgentBinary] = &[
    binary(AgentProvider::Claude, "claude"),
    binary(AgentProvider::Codex, "codex"),
    binary(AgentProvider::Kimi, "kimi"),
    binary(AgentProvider::Kimi, "kimi-code"),
    binary(AgentProvider::Gemini, "gemini"),
    binary(AgentProvider::Cursor, "cursor-agent"),
    binary(AgentProvider::Copilot, "copilot"),
    binary(AgentProvider::Opencode, "opencode"),
    binary(AgentProvider::Amp, "amp"),
    binary(AgentProvider::Goose, "goose"),
    binary(AgentProvider::Droid, "droid"),
    binary(AgentProvider::Auggie, "auggie"),
    binary(AgentProvider::Grok, "grok"),
    binary(AgentProvider::Hermes, "hermes"),
    binary(AgentProvider::QwenCode, "qwen"),
    binary(AgentProvider::Cline, "cline"),
    binary(AgentProvider::Continue, "cn"),
    binary(AgentProvider::Charm, "crush"),
    binary(AgentProvider::Codebuff, "codebuff"),
    binary(AgentProvider::Kilocode, "kilo"),
    binary(AgentProvider::Kiro, "kiro"),
    binary(AgentProvider::Kiro, "kiro-cli"),
    binary_with(AgentProvider::RovoDev, "acli", "rovodev"),
    binary(AgentProvider::MistralVibe, "vibe"),
    binary(AgentProvider::MistralVibe, "vibe-acp"),
    binary(AgentProvider::Antigravity, "agy"),
    binary(AgentProvider::Openclaude, "openclaude"),
    binary(AgentProvider::Pi, "pi"),
    binary(AgentProvider::OhMyPi, "omp"),
    binary(AgentProvider::CommandCode, "cmd"),
    binary(AgentProvider::CommandCode, "command-code"),
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AgentProcess {
    pub pid: u32,
    pub provider: AgentProvider,
    pub start_time: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ForegroundProcess {
    pub pid: u32,
    pub start_time: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessRecord {
    pub pid: u32,
    pub parent_pid: u32,
    /// POSIX process-session id (`sid`), sampled on the Host that owns the
    /// process. A remote client must never infer this from its local process
    /// table.
    pub session_id: u32,
    pub command: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessSnapshot {
    /// Increments only after the shared sampler completes a fresh OS census.
    pub revision: u64,
    pub processes: Vec<ProcessRecord>,
}

#[derive(Clone)]
pub struct SharedProcessSampler {
    paths: SamplerPaths,
    freshness: Duration,
    source: Arc<dyn ProcessSource>,
    fallback: Arc<LocalFallback>,
}

/// The private sampler this process falls back to when the socket peer will
/// not serve it.
///
/// The shared daemon is a *performance* optimisation — one `ps` census shared
/// between processes — and `SharedSamplerState` already does the whole job
/// in-process. Correctness must therefore never depend on winning the socket:
/// the peer holding it may be another checkout's live session, which we are
/// not entitled to evict.
#[derive(Default)]
struct LocalFallback {
    state: Mutex<Option<Arc<SharedSamplerState>>>,
    reason: Mutex<Option<String>>,
    retry_after: Mutex<Option<Instant>>,
    unresponsive_attempts: AtomicU32,
}

impl std::fmt::Debug for SharedProcessSampler {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SharedProcessSampler")
            .field("runtime_dir", &self.paths.runtime_dir)
            .field("freshness", &self.freshness)
            .finish_non_exhaustive()
    }
}

impl SharedProcessSampler {
    pub fn host_default() -> io::Result<Self> {
        Self::with_runtime_dir(default_runtime_dir()?)
    }

    pub fn with_runtime_dir(runtime_dir: PathBuf) -> io::Result<Self> {
        Self::with_source(runtime_dir, DEFAULT_FRESHNESS, Arc::new(PsProcessSource))
    }

    fn with_source(
        runtime_dir: PathBuf,
        freshness: Duration,
        source: Arc<dyn ProcessSource>,
    ) -> io::Result<Self> {
        let paths = SamplerPaths::prepare(runtime_dir)?;
        Ok(Self {
            paths,
            freshness,
            source,
            fallback: Arc::new(LocalFallback::default()),
        })
    }

    pub fn agent_process(&self, root_pid: u32) -> io::Result<Option<AgentProcess>> {
        if root_pid == 0 {
            return Ok(None);
        }
        match self.exchange(SamplerRequest::Agent(root_pid))? {
            PeerOutcome::Answered(response) => self.validate_agent_response(response),
            PeerOutcome::Unusable(state) => state.agent_process(root_pid),
        }
    }

    pub fn process_snapshot(&self) -> io::Result<ProcessSnapshot> {
        match self.exchange(SamplerRequest::Snapshot)? {
            PeerOutcome::Answered(response) => self.validate_snapshot_response(response),
            PeerOutcome::Unusable(state) => state.process_snapshot(),
        }
    }

    /// Performs a new, bounded OS process census and returns only that census.
    ///
    /// Unlike [`Self::process_snapshot`], this request is never satisfied from
    /// the normal freshness cache. A concurrent census, a source failure, or
    /// an internally truncated record set returns an error so destructive
    /// callers can fail closed.
    pub fn fresh_process_snapshot(&self) -> io::Result<ProcessSnapshot> {
        match self.exchange(SamplerRequest::FreshSnapshot)? {
            PeerOutcome::Answered(response) => self.validate_snapshot_response(response),
            PeerOutcome::Unusable(state) => state.fresh_process_snapshot(),
        }
    }

    /// Returns a recent, complete census while coalescing concurrent callers.
    ///
    /// This is for destructive callers that perform their own stronger
    /// linearization check immediately before mutation. A cached result is
    /// returned only when it is no older than `max_age`, contains
    /// `required_pid`, came from a successful complete census, and no later
    /// sampling failure invalidated it. Waiters are bounded and fail closed.
    pub fn complete_process_snapshot_containing(
        &self,
        required_pid: u32,
        max_age: Duration,
    ) -> io::Result<ProcessSnapshot> {
        if required_pid == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "complete process snapshot requires a nonzero process id",
            ));
        }
        let max_age_ms = complete_snapshot_max_age_ms(max_age)?;
        match self.exchange(SamplerRequest::CompleteSnapshot {
            required_pid,
            max_age_ms,
        })? {
            PeerOutcome::Answered(response) => self.validate_snapshot_response(response),
            PeerOutcome::Unusable(state) => {
                state.complete_process_snapshot_containing(required_pid, max_age)
            }
        }
    }

    pub fn foreground_process(&self, root_pid: u32) -> io::Result<Option<ForegroundProcess>> {
        if root_pid == 0 {
            return Ok(None);
        }
        match self.exchange(SamplerRequest::Foreground(root_pid))? {
            PeerOutcome::Answered(response) => self.validate_foreground_response(response),
            PeerOutcome::Unusable(state) => state.foreground_process(root_pid),
        }
    }

    /// Why this peer, if any, is not being used.
    ///
    /// Callers and tests need the *reason* a shared sampler stopped being
    /// shared; the old code turned it into an `Err` that every caller flattened
    /// away, which is how a permanent protocol mismatch came to look exactly
    /// like "this pid is not an agent".
    #[must_use]
    pub fn degraded_peer_reason(&self) -> Option<String> {
        self.fallback.reason.lock().ok()?.clone()
    }

    /// One round trip, classified.
    ///
    /// Three outcomes have to stay distinguishable: the peer answered, the peer
    /// will not serve this build (fall back locally), or something transient
    /// went wrong (report it). Collapsing the middle one into either of the
    /// others is the defect this function exists to prevent.
    fn exchange(&self, request: SamplerRequest) -> io::Result<PeerOutcome> {
        if let Some(state) = self.cooling_down_fallback()? {
            return Ok(PeerOutcome::Unusable(state));
        }
        let first = match self.request(request) {
            Ok(response) => {
                self.peer_responded()?;
                return Ok(PeerOutcome::Answered(response));
            }
            Err(error) => error,
        };
        if is_peer_unusable(&first) {
            return self.degrade(&first).map(PeerOutcome::Unusable);
        }
        if !is_owner_recovery_error(&first) {
            return Err(first);
        }
        self.ensure_server()?;
        match self.request(request) {
            Ok(response) => {
                self.peer_responded()?;
                Ok(PeerOutcome::Answered(response))
            }
            // Ownership recovery already ran and the peer still will not
            // answer, so retrying on the caller's next poll would only repeat
            // this. `ensure_server` cannot dislodge a live peer by design —
            // it may belong to another checkout's session — so serve locally.
            Err(second) if is_peer_unusable(&second) || is_owner_recovery_error(&second) => {
                self.degrade(&second).map(PeerOutcome::Unusable)
            }
            Err(second) => Err(second),
        }
    }

    fn cooling_down_fallback(&self) -> io::Result<Option<Arc<SharedSamplerState>>> {
        let mut retry_after = self
            .fallback
            .retry_after
            .lock()
            .map_err(|_| io::Error::other("process sampler recovery lock is poisoned"))?;
        let Some(deadline) = *retry_after else {
            return Ok(None);
        };
        let now = Instant::now();
        if now >= deadline {
            // The next ordinary request owns the probe. Concurrent callers
            // keep using local observation until it answers; no timer or
            // extra request is needed to return to shared sampling.
            *retry_after = Some(now + PEER_RECOVERY_INTERVAL);
            return Ok(None);
        }
        self.local_state().map(Some)
    }

    fn peer_responded(&self) -> io::Result<()> {
        self.fallback
            .unresponsive_attempts
            .store(0, Ordering::SeqCst);
        let mut retry_after = self
            .fallback
            .retry_after
            .lock()
            .map_err(|_| io::Error::other("process sampler recovery lock is poisoned"))?;
        if retry_after.take().is_some() {
            *self.fallback.reason.lock().map_err(|_| {
                io::Error::other("process sampler fallback reason lock is poisoned")
            })? = None;
            *self.fallback.state.lock().map_err(|_| {
                io::Error::other("process sampler fallback state lock is poisoned")
            })? = None;
        }
        Ok(())
    }

    fn local_state(&self) -> io::Result<Arc<SharedSamplerState>> {
        let mut state = self
            .fallback
            .state
            .lock()
            .map_err(|_| io::Error::other("process sampler fallback state lock is poisoned"))?;
        Ok(Arc::clone(state.get_or_insert_with(|| {
            Arc::new(SharedSamplerState::new(
                self.freshness,
                Arc::clone(&self.source),
            ))
        })))
    }

    fn degrade(&self, error: &io::Error) -> io::Result<Arc<SharedSamplerState>> {
        let defer_peer = error.kind() == io::ErrorKind::Unsupported
            || self
                .fallback
                .unresponsive_attempts
                .fetch_add(1, Ordering::SeqCst)
                + 1
                >= MAX_UNRESPONSIVE_ATTEMPTS;
        if defer_peer {
            *self
                .fallback
                .retry_after
                .lock()
                .map_err(|_| io::Error::other("process sampler recovery lock is poisoned"))? =
                Some(Instant::now() + PEER_RECOVERY_INTERVAL);
            let reason = format!(
                "{} is served by a peer this build cannot use: {error}",
                self.paths.socket.display()
            );
            if let Ok(mut slot) = self.fallback.reason.lock() {
                *slot = Some(reason.clone());
            }
            announce_local_fallback(&reason);
        }
        self.local_state()
    }

    fn request(&self, request: SamplerRequest) -> io::Result<SamplerResponse> {
        let mut stream = UnixStream::connect(&self.paths.socket)?;
        let deadline = Instant::now() + IO_TIMEOUT;
        write_all_before(&mut stream, &encode_request(request), deadline).map_err(|error| {
            io::Error::new(
                error.kind(),
                format!("failed to write process sampler request: {error}"),
            )
        })?;
        verify_peer_attestation(&mut stream, deadline)?;

        let mut header = [0_u8; RESPONSE_HEADER_BYTES];
        read_exact_before(&mut stream, &mut header, deadline).map_err(|error| {
            io::Error::new(
                error.kind(),
                format!("failed to read process sampler response header: {error}"),
            )
        })?;
        let payload_bytes = declared_response_payload_bytes(header)?;
        let mut payload = vec![0_u8; payload_bytes];
        read_exact_before(&mut stream, &mut payload, deadline).map_err(|error| {
            io::Error::new(
                error.kind(),
                format!("failed to read process sampler response payload: {error}"),
            )
        })?;
        decode_response(header, &payload)
    }

    fn validate_agent_response(
        &self,
        response: SamplerResponse,
    ) -> io::Result<Option<AgentProcess>> {
        match response {
            SamplerResponse::None => Ok(None),
            SamplerResponse::Unavailable => Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "shared process sampler is temporarily unavailable",
            )),
            SamplerResponse::Agent(process) => {
                if process_start_time(process.pid) != Some(process.start_time) {
                    return Err(io::Error::new(
                        io::ErrorKind::WouldBlock,
                        "shared process sampler returned a stale process instance",
                    ));
                }
                Ok(Some(process))
            }
            SamplerResponse::Snapshot(_) => Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "shared process sampler returned a snapshot for an agent request",
            )),
            SamplerResponse::Foreground(_) => Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "shared process sampler returned a foreground process for an agent request",
            )),
        }
    }

    fn validate_snapshot_response(&self, response: SamplerResponse) -> io::Result<ProcessSnapshot> {
        match response {
            SamplerResponse::Snapshot(snapshot) => Ok(snapshot),
            SamplerResponse::Unavailable => Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "shared process sampler is temporarily unavailable",
            )),
            SamplerResponse::None | SamplerResponse::Agent(_) | SamplerResponse::Foreground(_) => {
                Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "shared process sampler returned an agent result for a snapshot request",
                ))
            }
        }
    }

    fn validate_foreground_response(
        &self,
        response: SamplerResponse,
    ) -> io::Result<Option<ForegroundProcess>> {
        match response {
            SamplerResponse::None => Ok(None),
            SamplerResponse::Unavailable => Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "shared process sampler is temporarily unavailable",
            )),
            SamplerResponse::Foreground(process) => {
                if process_start_time(process.pid) != Some(process.start_time) {
                    return Err(io::Error::new(
                        io::ErrorKind::WouldBlock,
                        "shared process sampler returned a stale foreground process",
                    ));
                }
                Ok(Some(process))
            }
            SamplerResponse::Agent(_) | SamplerResponse::Snapshot(_) => Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "shared process sampler returned the wrong result for a foreground request",
            )),
        }
    }

    fn ensure_server(&self) -> io::Result<()> {
        let lock = self.paths.open_lock()?;
        FileExt::lock_exclusive(&lock)?;

        if UnixStream::connect(&self.paths.socket).is_ok() {
            FileExt::unlock(&lock)?;
            return Ok(());
        }
        self.paths.remove_stale_socket()?;
        let listener = UnixListener::bind(&self.paths.socket)?;
        fs::set_permissions(&self.paths.socket, fs::Permissions::from_mode(0o600))?;

        let expected_uid = effective_uid();
        let freshness = self.freshness;
        let source = Arc::clone(&self.source);
        thread::Builder::new()
            .name("hebbian-process-sampler".into())
            .spawn(move || serve(listener, expected_uid, freshness, source))
            .inspect_err(|_| {
                let _ = fs::remove_file(&self.paths.socket);
            })?;
        FileExt::unlock(&lock)
    }
}

#[derive(Clone, Debug)]
struct SamplerPaths {
    runtime_dir: PathBuf,
    socket: PathBuf,
    lock: PathBuf,
}

impl SamplerPaths {
    fn prepare(runtime_dir: PathBuf) -> io::Result<Self> {
        if !runtime_dir.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "process sampler runtime directory must be absolute",
            ));
        }
        fs::create_dir_all(&runtime_dir)?;
        let metadata = fs::symlink_metadata(&runtime_dir)?;
        if metadata.file_type().is_symlink()
            || !metadata.is_dir()
            || metadata.uid() != effective_uid()
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "process sampler runtime directory is not owned by the current user",
            ));
        }
        if metadata.permissions().mode() & 0o077 != 0 {
            fs::set_permissions(&runtime_dir, fs::Permissions::from_mode(0o700))?;
        }
        // Derived, never spelled out: a hand-written "v2" here is exactly how
        // the path drifted away from the framing it is supposed to describe.
        Ok(Self {
            socket: runtime_dir.join(format!("process-sampler-v{PROTOCOL_VERSION}.sock")),
            lock: runtime_dir.join(format!("process-sampler-v{PROTOCOL_VERSION}.lock")),
            runtime_dir,
        })
    }

    fn open_lock(&self) -> io::Result<File> {
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&self.lock)?;
        let metadata = lock.metadata()?;
        if !metadata.is_file() || metadata.uid() != effective_uid() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "process sampler startup lock is not owned by the current user",
            ));
        }
        Ok(lock)
    }

    fn remove_stale_socket(&self) -> io::Result<()> {
        match fs::symlink_metadata(&self.socket) {
            Ok(metadata)
                if metadata.file_type().is_socket() && metadata.uid() == effective_uid() =>
            {
                fs::remove_file(&self.socket)
            }
            Ok(_) => Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "refusing to replace an unsafe process sampler socket path",
            )),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    }
}

fn default_runtime_dir() -> io::Result<PathBuf> {
    if let Some(runtime_dir) = std::env::var_os("XDG_RUNTIME_DIR") {
        let runtime_dir = PathBuf::from(runtime_dir);
        if runtime_dir.is_absolute() {
            return Ok(runtime_dir.join("hebbian"));
        }
    }
    Ok(std::env::temp_dir().join(format!("hebbian-runtime-{}", effective_uid())))
}

fn effective_uid() -> u32 {
    unsafe { libc::geteuid() }
}

fn complete_snapshot_max_age_ms(max_age: Duration) -> io::Result<u32> {
    let max_age_ms = max_age.as_millis();
    if max_age_ms == 0 || max_age > MAX_COMPLETE_SNAPSHOT_AGE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "complete process snapshot max age must be between 1ms and {}ms",
                MAX_COMPLETE_SNAPSHOT_AGE.as_millis()
            ),
        ));
    }
    u32::try_from(max_age_ms).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "complete process snapshot max age is out of range",
        )
    })
}

/// A peer that answered the connect but will not produce answers for us.
///
/// `Unsupported` is a proven protocol mismatch; `TimedOut` is a peer that
/// accepted and then went silent. Both used to reach the caller as an opaque
/// `Err` that every call site flattened into "no agent here", which is how a
/// sub-millisecond, permanent failure surfaced fifteen seconds later as an
/// unrelated deadline.
fn is_peer_unusable(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::Unsupported | io::ErrorKind::TimedOut
    )
}

/// Say it once, name the socket, then stop.
///
/// Silence here cost a red `main` and a misattributed commit: the detection
/// loop retried every 750 ms forever and never told anyone why nothing came
/// back. Once is enough — repeating it every poll would be its own noise.
fn announce_local_fallback(reason: &str) {
    if !LOCAL_FALLBACK_ANNOUNCED.swap(true, Ordering::SeqCst) {
        eprintln!(
            "hebbian-process-sampler: {reason}; using a private process sample for this process"
        );
    }
}

/// Read the peer's protocol attestation before trusting anything it says.
fn verify_peer_attestation(stream: &mut UnixStream, deadline: Instant) -> io::Result<()> {
    let mut frame = [0_u8; ATTESTATION_BYTES];
    match read_exact_before(stream, &mut frame, deadline) {
        Ok(()) => {}
        // A peer that speaks this protocol always attests first, so a socket
        // that accepts and then closes is not a flaky connection — it is a
        // build that cannot decode our frames.
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                format!(
                    "process sampler peer closed without attesting a protocol version; \
                     this build speaks v{PROTOCOL_VERSION}"
                ),
            ));
        }
        Err(error) => {
            return Err(io::Error::new(
                error.kind(),
                format!("failed to read process sampler attestation: {error}"),
            ));
        }
    }
    if &frame[..4] != ATTESTATION_MAGIC {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            format!(
                "process sampler peer attested an unrecognised protocol; \
                 this build speaks v{PROTOCOL_VERSION}"
            ),
        ));
    }
    let peer_version = u32::from_be_bytes(frame[4..8].try_into().unwrap());
    if peer_version != PROTOCOL_VERSION {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            format!(
                "process sampler peer serves protocol v{peer_version}, \
                 this build speaks v{PROTOCOL_VERSION}"
            ),
        ));
    }
    Ok(())
}

fn encode_attestation() -> [u8; ATTESTATION_BYTES] {
    let mut bytes = [0_u8; ATTESTATION_BYTES];
    bytes[..4].copy_from_slice(ATTESTATION_MAGIC);
    bytes[4..8].copy_from_slice(&PROTOCOL_VERSION.to_be_bytes());
    bytes
}

fn is_owner_recovery_error(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::NotFound
            | io::ErrorKind::ConnectionRefused
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::ConnectionAborted
            | io::ErrorKind::BrokenPipe
            | io::ErrorKind::UnexpectedEof
    ) || matches!(
        error.raw_os_error(),
        Some(libc::ENOTSOCK | libc::EPROTOTYPE)
    )
}

fn serve(
    listener: UnixListener,
    expected_uid: u32,
    freshness: Duration,
    source: Arc<dyn ProcessSource>,
) {
    let sampler = Arc::new(SharedSamplerState::new(freshness, source));
    let (connections_tx, connections_rx) = sync_channel(MAX_PENDING_CONNECTIONS);
    let worker_count = spawn_sampler_workers(
        connections_rx,
        sampler,
        |worker_index, receiver, sampler| {
            thread::Builder::new()
                .name(format!("hebbian-process-sampler-{worker_index}"))
                .spawn(move || sampler_worker(receiver, sampler))
                .map(|_| ())
        },
    );
    if worker_count == 0 {
        return;
    }

    for incoming in listener.incoming() {
        let Ok(stream) = incoming else {
            continue;
        };
        if peer_uid(&stream) != Some(expected_uid) {
            continue;
        }
        match connections_tx.try_send(stream) {
            Ok(()) => {}
            // Dropping the stream would reach the client as a bare EOF, which
            // is the signature of a peer that cannot speak this protocol at
            // all — and would demote a merely busy daemon to temporarily
            // unusable. Overload is transient, so say so.
            Err(TrySendError::Full(stream)) => refuse_overloaded_connection(stream),
            Err(TrySendError::Disconnected(_)) => return,
        }
    }
}

fn spawn_sampler_workers<F>(
    connections_rx: std::sync::mpsc::Receiver<UnixStream>,
    sampler: Arc<SharedSamplerState>,
    mut spawn: F,
) -> usize
where
    F: FnMut(
        usize,
        Arc<Mutex<std::sync::mpsc::Receiver<UnixStream>>>,
        Arc<SharedSamplerState>,
    ) -> io::Result<()>,
{
    let connections_rx = Arc::new(Mutex::new(connections_rx));
    let mut worker_count = 0;
    for worker_index in 0..MAX_SAMPLER_WORKERS {
        if spawn(
            worker_index,
            Arc::clone(&connections_rx),
            Arc::clone(&sampler),
        )
        .is_ok()
        {
            worker_count += 1;
        }
    }
    // Do not keep a receiver alive in the accept thread. If every worker exits,
    // the next enqueue observes Disconnected and tears down the stale listener.
    worker_count
}

fn sampler_worker(
    connections_rx: Arc<Mutex<std::sync::mpsc::Receiver<UnixStream>>>,
    sampler: Arc<SharedSamplerState>,
) {
    loop {
        let stream = {
            let Ok(receiver) = connections_rx.lock() else {
                return;
            };
            let Ok(stream) = receiver.recv() else {
                return;
            };
            stream
        };
        handle_connection(stream, &sampler);
    }
}

fn refuse_overloaded_connection(mut stream: UnixStream) {
    let deadline = Instant::now() + OVERLOAD_REPLY_TIMEOUT;
    if write_all_before(&mut stream, &encode_attestation(), deadline).is_err() {
        return;
    }
    if let Ok(encoded) = encode_response(SamplerResponse::Unavailable) {
        let _ = write_all_before(&mut stream, &encoded, deadline);
    }
}

fn handle_connection(mut stream: UnixStream, sampler: &SharedSamplerState) {
    let request_deadline = Instant::now() + IO_TIMEOUT;
    // Attest before reading anything. A client speaking another version must
    // be told what this daemon serves rather than left to infer it from a
    // closed socket, and writing first costs no extra round trip: the request
    // is already in flight while this is being written.
    if write_all_before(&mut stream, &encode_attestation(), request_deadline).is_err() {
        return;
    }
    let mut request = [0_u8; REQUEST_BYTES];
    if read_exact_before(&mut stream, &mut request, request_deadline).is_err() {
        return;
    }
    let Ok(request) = decode_request(request) else {
        return;
    };
    let response = match request {
        SamplerRequest::Agent(root_pid) => match sampler.agent_process(root_pid) {
            Ok(Some(process)) => SamplerResponse::Agent(process),
            Ok(None) => SamplerResponse::None,
            Err(_) => SamplerResponse::Unavailable,
        },
        SamplerRequest::Foreground(root_pid) => match sampler.foreground_process(root_pid) {
            Ok(Some(process)) => SamplerResponse::Foreground(process),
            Ok(None) => SamplerResponse::None,
            Err(_) => SamplerResponse::Unavailable,
        },
        SamplerRequest::Snapshot => match sampler.process_snapshot() {
            Ok(snapshot) => SamplerResponse::Snapshot(snapshot),
            Err(_) => SamplerResponse::Unavailable,
        },
        SamplerRequest::FreshSnapshot => match sampler.fresh_process_snapshot() {
            Ok(snapshot) => SamplerResponse::Snapshot(snapshot),
            Err(_) => SamplerResponse::Unavailable,
        },
        SamplerRequest::CompleteSnapshot {
            required_pid,
            max_age_ms,
        } => match sampler.complete_process_snapshot_containing(
            required_pid,
            Duration::from_millis(u64::from(max_age_ms)),
        ) {
            Ok(snapshot) => SamplerResponse::Snapshot(snapshot),
            Err(_) => SamplerResponse::Unavailable,
        },
    };
    let encoded =
        encode_response(response).or_else(|_| encode_response(SamplerResponse::Unavailable));
    if let Ok(encoded) = encoded {
        let _ = write_all_before(&mut stream, &encoded, Instant::now() + IO_TIMEOUT);
    }
}

fn read_exact_before(
    stream: &mut UnixStream,
    mut buffer: &mut [u8],
    deadline: Instant,
) -> io::Result<()> {
    stream.set_nonblocking(true)?;
    while !buffer.is_empty() {
        match stream.read(buffer) {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "process sampler stream closed before the frame completed",
                ));
            }
            Ok(read) => {
                buffer = &mut buffer[read..];
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                wait_for_io(stream, libc::POLLIN, deadline)?;
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn write_all_before(
    stream: &mut UnixStream,
    mut buffer: &[u8],
    deadline: Instant,
) -> io::Result<()> {
    stream.set_nonblocking(true)?;
    while !buffer.is_empty() {
        match stream.write(buffer) {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "process sampler stream stopped accepting the frame",
                ));
            }
            Ok(written) => buffer = &buffer[written..],
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                wait_for_io(stream, libc::POLLOUT, deadline)?;
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn wait_for_io(stream: &UnixStream, events: i16, deadline: Instant) -> io::Result<()> {
    loop {
        let remaining = remaining_timeout(deadline)?;
        let timeout_ms = i32::try_from(remaining.as_millis().max(1)).unwrap_or(i32::MAX);
        let mut descriptor = libc::pollfd {
            fd: stream.as_raw_fd(),
            events,
            revents: 0,
        };
        let result = unsafe { libc::poll(&mut descriptor, 1, timeout_ms) };
        if result > 0 {
            if descriptor.revents & libc::POLLNVAL != 0 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "process sampler stream descriptor became invalid",
                ));
            }
            return Ok(());
        }
        if result == 0 {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "process sampler frame deadline expired",
            ));
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

fn remaining_timeout(deadline: Instant) -> io::Result<Duration> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "process sampler frame deadline expired",
        ))
    } else {
        Ok(remaining)
    }
}

#[cfg(target_os = "linux")]
fn peer_uid(stream: &UnixStream) -> Option<u32> {
    let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut credentials as *mut libc::ucred).cast(),
            &mut length,
        )
    };
    (result == 0).then_some(credentials.uid)
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn peer_uid(stream: &UnixStream) -> Option<u32> {
    let mut uid = 0;
    let mut gid = 0;
    let result = unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) };
    (result == 0).then_some(uid)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "ios")))]
fn peer_uid(_stream: &UnixStream) -> Option<u32> {
    None
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SamplerRequest {
    Agent(u32),
    Foreground(u32),
    Snapshot,
    FreshSnapshot,
    CompleteSnapshot { required_pid: u32, max_age_ms: u32 },
}

/// What one round trip with the socket peer produced.
enum PeerOutcome {
    Answered(SamplerResponse),
    Unusable(Arc<SharedSamplerState>),
}

fn encode_request(request: SamplerRequest) -> [u8; REQUEST_BYTES] {
    let mut bytes = [0_u8; REQUEST_BYTES];
    bytes[..4].copy_from_slice(REQUEST_MAGIC);
    bytes[4..8].copy_from_slice(&PROTOCOL_VERSION.to_be_bytes());
    match request {
        SamplerRequest::Agent(root_pid) => {
            bytes[8] = REQUEST_AGENT;
            bytes[12..16].copy_from_slice(&root_pid.to_be_bytes());
        }
        SamplerRequest::Foreground(root_pid) => {
            bytes[8] = REQUEST_FOREGROUND;
            bytes[12..16].copy_from_slice(&root_pid.to_be_bytes());
        }
        SamplerRequest::Snapshot => bytes[8] = REQUEST_SNAPSHOT,
        SamplerRequest::FreshSnapshot => bytes[8] = REQUEST_FRESH_SNAPSHOT,
        SamplerRequest::CompleteSnapshot {
            required_pid,
            max_age_ms,
        } => {
            bytes[8] = REQUEST_COMPLETE_SNAPSHOT;
            bytes[12..16].copy_from_slice(&required_pid.to_be_bytes());
            bytes[16..20].copy_from_slice(&max_age_ms.to_be_bytes());
        }
    }
    bytes
}

fn decode_request(bytes: [u8; REQUEST_BYTES]) -> io::Result<SamplerRequest> {
    if &bytes[..4] != REQUEST_MAGIC
        || u32::from_be_bytes(bytes[4..8].try_into().unwrap()) != PROTOCOL_VERSION
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid process sampler request magic",
        ));
    }
    match bytes[8] {
        REQUEST_AGENT | REQUEST_FOREGROUND => {
            let root_pid = u32::from_be_bytes(bytes[12..16].try_into().unwrap());
            if root_pid == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "invalid process sampler root pid",
                ));
            }
            Ok(if bytes[8] == REQUEST_AGENT {
                SamplerRequest::Agent(root_pid)
            } else {
                SamplerRequest::Foreground(root_pid)
            })
        }
        REQUEST_SNAPSHOT => Ok(SamplerRequest::Snapshot),
        REQUEST_FRESH_SNAPSHOT => Ok(SamplerRequest::FreshSnapshot),
        REQUEST_COMPLETE_SNAPSHOT => {
            let required_pid = u32::from_be_bytes(bytes[12..16].try_into().unwrap());
            if required_pid == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "complete process snapshot requires a nonzero process id",
                ));
            }
            let max_age_ms = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
            complete_snapshot_max_age_ms(Duration::from_millis(u64::from(max_age_ms)))?;
            Ok(SamplerRequest::CompleteSnapshot {
                required_pid,
                max_age_ms,
            })
        }
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid process sampler request operation",
        )),
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum SamplerResponse {
    None,
    Agent(AgentProcess),
    Foreground(ForegroundProcess),
    Snapshot(ProcessSnapshot),
    Unavailable,
}

fn encode_response(response: SamplerResponse) -> io::Result<Vec<u8>> {
    let (status, payload) = match response {
        SamplerResponse::None => (STATUS_NONE, Vec::new()),
        SamplerResponse::Unavailable => (STATUS_UNAVAILABLE, Vec::new()),
        SamplerResponse::Agent(process) => {
            let mut payload = vec![0_u8; AGENT_PAYLOAD_BYTES];
            payload[0] = process.provider.wire_code();
            payload[4..8].copy_from_slice(&process.pid.to_be_bytes());
            payload[8..16].copy_from_slice(&process.start_time.to_be_bytes());
            (STATUS_AGENT, payload)
        }
        SamplerResponse::Foreground(process) => {
            let mut payload = vec![0_u8; FOREGROUND_PAYLOAD_BYTES];
            payload[4..8].copy_from_slice(&process.pid.to_be_bytes());
            payload[8..16].copy_from_slice(&process.start_time.to_be_bytes());
            (STATUS_FOREGROUND, payload)
        }
        SamplerResponse::Snapshot(snapshot) => {
            if snapshot.processes.len() > MAX_PROCESS_RECORDS {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "process sampler snapshot has too many records",
                ));
            }
            let mut payload = Vec::new();
            payload.extend_from_slice(&snapshot.revision.to_be_bytes());
            payload.extend_from_slice(
                &u32::try_from(snapshot.processes.len())
                    .map_err(|_| {
                        io::Error::new(
                            io::ErrorKind::InvalidData,
                            "process sampler snapshot record count overflow",
                        )
                    })?
                    .to_be_bytes(),
            );
            for process in snapshot.processes {
                let command = process.command.as_bytes();
                if process.pid == 0
                    || command.len() > MAX_COMMAND_BYTES
                    || payload
                        .len()
                        .checked_add(16 + command.len())
                        .is_none_or(|size| size > MAX_RESPONSE_PAYLOAD_BYTES)
                {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "invalid process sampler snapshot record",
                    ));
                }
                payload.extend_from_slice(&process.pid.to_be_bytes());
                payload.extend_from_slice(&process.parent_pid.to_be_bytes());
                payload.extend_from_slice(&process.session_id.to_be_bytes());
                payload.extend_from_slice(
                    &u32::try_from(command.len())
                        .map_err(|_| {
                            io::Error::new(
                                io::ErrorKind::InvalidData,
                                "process sampler command length overflow",
                            )
                        })?
                        .to_be_bytes(),
                );
                payload.extend_from_slice(command);
            }
            (STATUS_SNAPSHOT, payload)
        }
    };
    let payload_bytes = u32::try_from(payload.len()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "process sampler response payload overflow",
        )
    })?;
    let mut bytes = Vec::with_capacity(RESPONSE_HEADER_BYTES + payload.len());
    bytes.extend_from_slice(RESPONSE_MAGIC);
    bytes.push(status);
    bytes.extend_from_slice(&[0_u8; 3]);
    bytes.extend_from_slice(&payload_bytes.to_be_bytes());
    bytes.extend_from_slice(&payload);
    Ok(bytes)
}

fn declared_response_payload_bytes(header: [u8; RESPONSE_HEADER_BYTES]) -> io::Result<usize> {
    if &header[..4] != RESPONSE_MAGIC {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid process sampler response magic",
        ));
    }
    let payload_bytes = u32::from_be_bytes(header[8..12].try_into().unwrap()) as usize;
    if payload_bytes > MAX_RESPONSE_PAYLOAD_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "process sampler response payload is too large",
        ));
    }
    Ok(payload_bytes)
}

fn decode_response(
    header: [u8; RESPONSE_HEADER_BYTES],
    payload: &[u8],
) -> io::Result<SamplerResponse> {
    if declared_response_payload_bytes(header)? != payload.len() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "process sampler response payload length mismatch",
        ));
    }
    match header[4] {
        STATUS_NONE if payload.is_empty() => Ok(SamplerResponse::None),
        STATUS_UNAVAILABLE if payload.is_empty() => Ok(SamplerResponse::Unavailable),
        STATUS_AGENT => {
            if payload.len() != AGENT_PAYLOAD_BYTES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "invalid process sampler agent payload length",
                ));
            }
            let provider = AgentProvider::from_wire_code(payload[0]).ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    "invalid process sampler provider",
                )
            })?;
            let pid = u32::from_be_bytes(payload[4..8].try_into().unwrap());
            let start_time = u64::from_be_bytes(payload[8..16].try_into().unwrap());
            if pid == 0 || start_time == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "invalid process sampler identity",
                ));
            }
            Ok(SamplerResponse::Agent(AgentProcess {
                pid,
                provider,
                start_time,
            }))
        }
        STATUS_FOREGROUND => {
            if payload.len() != FOREGROUND_PAYLOAD_BYTES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "invalid process sampler foreground payload length",
                ));
            }
            let pid = u32::from_be_bytes(payload[4..8].try_into().unwrap());
            let start_time = u64::from_be_bytes(payload[8..16].try_into().unwrap());
            if pid == 0 || start_time == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "invalid process sampler foreground identity",
                ));
            }
            Ok(SamplerResponse::Foreground(ForegroundProcess {
                pid,
                start_time,
            }))
        }
        STATUS_SNAPSHOT => decode_process_snapshot(payload).map(SamplerResponse::Snapshot),
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid process sampler response status",
        )),
    }
}

fn decode_process_snapshot(payload: &[u8]) -> io::Result<ProcessSnapshot> {
    let mut offset = 0;
    let revision = read_u64(payload, &mut offset)?;
    let record_count = read_u32(payload, &mut offset)? as usize;
    if revision == 0 || record_count > MAX_PROCESS_RECORDS {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid process sampler snapshot header",
        ));
    }
    let mut processes = Vec::with_capacity(record_count);
    for _ in 0..record_count {
        let pid = read_u32(payload, &mut offset)?;
        let parent_pid = read_u32(payload, &mut offset)?;
        let session_id = read_u32(payload, &mut offset)?;
        let command_bytes = read_u32(payload, &mut offset)? as usize;
        if pid == 0 || command_bytes > MAX_COMMAND_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid process sampler snapshot record",
            ));
        }
        let command_end = offset.checked_add(command_bytes).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "process sampler snapshot command length overflow",
            )
        })?;
        let command = payload.get(offset..command_end).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "truncated process sampler snapshot command",
            )
        })?;
        processes.push(ProcessRecord {
            pid,
            parent_pid,
            session_id,
            command: std::str::from_utf8(command)
                .map_err(|_| {
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        "process sampler snapshot command is not UTF-8",
                    )
                })?
                .to_string(),
        });
        offset = command_end;
    }
    if offset != payload.len() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "process sampler snapshot has trailing bytes",
        ));
    }
    Ok(ProcessSnapshot {
        revision,
        processes,
    })
}

fn read_u32(bytes: &[u8], offset: &mut usize) -> io::Result<u32> {
    let end = offset.checked_add(4).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "process sampler frame offset overflow",
        )
    })?;
    let value = u32::from_be_bytes(
        bytes
            .get(*offset..end)
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "truncated process sampler frame",
                )
            })?
            .try_into()
            .unwrap(),
    );
    *offset = end;
    Ok(value)
}

fn read_u64(bytes: &[u8], offset: &mut usize) -> io::Result<u64> {
    let end = offset.checked_add(8).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "process sampler frame offset overflow",
        )
    })?;
    let value = u64::from_be_bytes(
        bytes
            .get(*offset..end)
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "truncated process sampler frame",
                )
            })?
            .try_into()
            .unwrap(),
    );
    *offset = end;
    Ok(value)
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn process_session_id(pid: u32) -> io::Result<Option<u32>> {
    let pid = libc::pid_t::try_from(pid)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "process id is out of range"))?;
    let session_id = unsafe { libc::getsid(pid) };
    classify_process_session_id(if session_id < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(session_id)
    })
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
fn classify_process_session_id(result: io::Result<libc::pid_t>) -> io::Result<Option<u32>> {
    match result {
        Ok(session_id) => u32::try_from(session_id)
            .map(Some)
            .map_err(|_| io::Error::other("process session id is out of range")),
        // A process seen by `ps` can naturally disappear before `getsid`.
        // It is no longer a live session member, so omitting that stale row
        // keeps the census exact rather than poisoning every fresh snapshot.
        Err(error) if error.raw_os_error() == Some(libc::ESRCH) => Ok(None),
        Err(error) => Err(error),
    }
}

trait ProcessSource: Send + Sync {
    fn sample(&self) -> io::Result<ProcessTable>;
}

struct PsProcessSource;

impl ProcessSource for PsProcessSource {
    fn sample(&self) -> io::Result<ProcessTable> {
        let mut command = CommandSpec::new("/bin/ps");
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        command.args(["-axo", "pid=,ppid=,pgid=,tpgid=,command="]);
        #[cfg(not(any(target_os = "macos", target_os = "ios")))]
        command.args(["-axo", "pid=,ppid=,sid=,pgid=,tpgid=,command="]);
        let output = run_bounded(&command, PROCESS_SAMPLE_TIMEOUT, MAX_PS_OUTPUT_BYTES).map_err(
            |failure| {
                let kind = if matches!(failure, CommandFailure::Timeout(_)) {
                    io::ErrorKind::TimedOut
                } else {
                    io::ErrorKind::Other
                };
                io::Error::new(
                    kind,
                    format!(
                        "bounded process table sampling failed at {}",
                        failure.stage()
                    ),
                )
            },
        )?;
        if !output.status.success() || output.exceeded_limit {
            return Err(io::Error::other("process table sampling failed"));
        }
        let snapshot = String::from_utf8_lossy(&output.stdout);
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        return Ok(ProcessTable::parse_with_os_session_ids(&snapshot));
        #[cfg(not(any(target_os = "macos", target_os = "ios")))]
        Ok(ProcessTable::parse(&snapshot))
    }
}

struct SamplerState {
    freshness: Duration,
    sampled_at: Option<Instant>,
    revision: u64,
    refresh_generation: u64,
    table: Option<ProcessTable>,
    last_sample_failed: bool,
    refresh_in_flight: bool,
    source: Arc<dyn ProcessSource>,
}

struct SharedSamplerState {
    state: Mutex<SamplerState>,
    refresh_completed: Condvar,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum RefreshKind {
    Cached,
    Fresh,
}

impl SharedSamplerState {
    fn new(freshness: Duration, source: Arc<dyn ProcessSource>) -> Self {
        Self {
            state: Mutex::new(SamplerState {
                freshness,
                sampled_at: None,
                revision: 0,
                refresh_generation: 0,
                table: None,
                last_sample_failed: false,
                refresh_in_flight: false,
                source,
            }),
            refresh_completed: Condvar::new(),
        }
    }

    fn refresh(&self, kind: RefreshKind) -> io::Result<()> {
        let source = {
            let mut state = self.lock()?;
            let refresh = kind == RefreshKind::Fresh
                || state
                    .sampled_at
                    .is_none_or(|sampled_at| sampled_at.elapsed() >= state.freshness);
            if !refresh {
                return state.availability();
            }
            if state.refresh_in_flight {
                return if kind == RefreshKind::Cached && state.table.is_some() {
                    Ok(())
                } else {
                    Err(io::Error::new(
                        io::ErrorKind::WouldBlock,
                        "a fresh process table census is already in flight",
                    ))
                };
            }
            state.refresh_in_flight = true;
            Arc::clone(&state.source)
        };

        self.run_refresh(source)
    }

    fn run_refresh(&self, source: Arc<dyn ProcessSource>) -> io::Result<()> {
        let sampled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| source.sample()))
            .unwrap_or_else(|_| Err(io::Error::other("process table sampler panicked")));
        let mut state = self.lock()?;
        state.sampled_at = Some(Instant::now());
        state.refresh_in_flight = false;
        state.refresh_generation = state.refresh_generation.saturating_add(1).max(1);
        let result = match sampled {
            Ok(table) => {
                state.table = Some(table);
                state.revision = state.revision.saturating_add(1).max(1);
                state.last_sample_failed = false;
                Ok(())
            }
            Err(error) => {
                state.last_sample_failed = true;
                Err(error)
            }
        };
        drop(state);
        self.refresh_completed.notify_all();
        result
    }

    fn agent_process(&self, root_pid: u32) -> io::Result<Option<AgentProcess>> {
        self.refresh(RefreshKind::Cached)?;
        let candidate = self
            .lock()?
            .table
            .as_ref()
            .and_then(|table| table.nearest_agent(root_pid));
        let Some(candidate) = candidate else {
            return Ok(None);
        };
        let Some(start_time) = process_start_time(candidate.pid) else {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "agent process exited during sampling",
            ));
        };
        Ok(Some(AgentProcess {
            pid: candidate.pid,
            provider: candidate.provider,
            start_time,
        }))
    }

    fn foreground_process(&self, root_pid: u32) -> io::Result<Option<ForegroundProcess>> {
        self.refresh(RefreshKind::Cached)?;
        let candidate = self
            .lock()?
            .table
            .as_ref()
            .and_then(|table| table.nearest_foreground(root_pid));
        let Some(pid) = candidate else {
            return Ok(None);
        };
        let Some(start_time) = process_start_time(pid) else {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "foreground process exited during sampling",
            ));
        };
        Ok(Some(ForegroundProcess { pid, start_time }))
    }

    fn process_snapshot(&self) -> io::Result<ProcessSnapshot> {
        self.refresh(RefreshKind::Cached)?;
        self.snapshot(false)
    }

    fn fresh_process_snapshot(&self) -> io::Result<ProcessSnapshot> {
        self.refresh(RefreshKind::Fresh)?;
        self.snapshot(true)
    }

    fn complete_process_snapshot_containing(
        &self,
        required_pid: u32,
        max_age: Duration,
    ) -> io::Result<ProcessSnapshot> {
        if required_pid == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "complete process snapshot requires a nonzero process id",
            ));
        }
        complete_snapshot_max_age_ms(max_age)?;
        let source = {
            let mut state = self.lock()?;
            if let Some(snapshot) = state.recent_complete_snapshot(required_pid, max_age) {
                return Ok(snapshot);
            }
            if state.refresh_in_flight {
                let observed_generation = state.refresh_generation;
                let (state, timeout) = self
                    .refresh_completed
                    .wait_timeout_while(state, COMPLETE_SNAPSHOT_WAIT_TIMEOUT, |state| {
                        state.refresh_generation == observed_generation
                    })
                    .map_err(|_| {
                        io::Error::other("shared process sampler state lock is poisoned")
                    })?;
                if timeout.timed_out() && state.refresh_generation == observed_generation {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "complete process table census wait timed out",
                    ));
                }
                return state.require_recent_complete_snapshot(required_pid, max_age);
            }
            state.refresh_in_flight = true;
            Arc::clone(&state.source)
        };

        self.run_refresh(source)?;
        self.lock()?
            .require_recent_complete_snapshot(required_pid, max_age)
    }

    fn snapshot(&self, require_complete: bool) -> io::Result<ProcessSnapshot> {
        let state = self.lock()?;
        if require_complete
            && state
                .table
                .as_ref()
                .is_some_and(|table| table.records_truncated || table.session_ids_incomplete)
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "fresh process table census is incomplete",
            ));
        }
        Ok(ProcessSnapshot {
            revision: state.revision,
            processes: state
                .table
                .as_ref()
                .map(|table| table.records.clone())
                .unwrap_or_default(),
        })
    }

    fn lock(&self) -> io::Result<std::sync::MutexGuard<'_, SamplerState>> {
        self.state
            .lock()
            .map_err(|_| io::Error::other("shared process sampler state lock is poisoned"))
    }
}

impl SamplerState {
    fn availability(&self) -> io::Result<()> {
        if self.last_sample_failed || self.table.is_none() {
            Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "process table sample is unavailable",
            ))
        } else {
            Ok(())
        }
    }

    fn recent_complete_snapshot(
        &self,
        required_pid: u32,
        max_age: Duration,
    ) -> Option<ProcessSnapshot> {
        if self.last_sample_failed
            || self
                .sampled_at
                .is_none_or(|sampled_at| sampled_at.elapsed() > max_age)
        {
            return None;
        }
        let table = self.table.as_ref()?;
        if table.records_truncated || table.session_ids_incomplete {
            return None;
        }
        if !table
            .records
            .iter()
            .any(|process| process.pid == required_pid)
        {
            return None;
        }
        Some(ProcessSnapshot {
            revision: self.revision,
            processes: table.records.clone(),
        })
    }

    fn require_recent_complete_snapshot(
        &self,
        required_pid: u32,
        max_age: Duration,
    ) -> io::Result<ProcessSnapshot> {
        if let Some(snapshot) = self.recent_complete_snapshot(required_pid, max_age) {
            return Ok(snapshot);
        }
        if self.last_sample_failed || self.table.is_none() {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "complete process table census is unavailable",
            ));
        }
        let table = self.table.as_ref().expect("process table checked above");
        if table.records_truncated || table.session_ids_incomplete {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "complete process table census is incomplete",
            ));
        }
        if !table
            .records
            .iter()
            .any(|process| process.pid == required_pid)
        {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "complete process table census does not contain the required process",
            ));
        }
        Err(io::Error::new(
            io::ErrorKind::WouldBlock,
            "complete process table census is stale",
        ))
    }
}

#[derive(Clone, Default)]
struct ProcessTable {
    children: HashMap<u32, Vec<u32>>,
    agents: HashMap<u32, AgentProvider>,
    terminal_groups: HashMap<u32, TerminalProcessGroups>,
    records: Vec<ProcessRecord>,
    records_truncated: bool,
    session_ids_incomplete: bool,
}

#[derive(Clone, Copy, Default)]
struct TerminalProcessGroups {
    process_group: i32,
    foreground_process_group: i32,
}

impl ProcessTable {
    #[cfg(any(test, not(any(target_os = "macos", target_os = "ios"))))]
    fn parse(snapshot: &str) -> Self {
        Self::parse_with_record_limit(snapshot, MAX_PROCESS_RECORDS)
    }

    #[cfg(any(test, not(any(target_os = "macos", target_os = "ios"))))]
    fn parse_with_record_limit(snapshot: &str, record_limit: usize) -> Self {
        Self::parse_with_layout(snapshot, record_limit, true)
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    fn parse_with_os_session_ids(snapshot: &str) -> Self {
        Self::parse_with_layout(snapshot, MAX_PROCESS_RECORDS, false)
    }

    fn parse_with_layout(snapshot: &str, record_limit: usize, has_session_column: bool) -> Self {
        let mut table = Self::default();
        for line in snapshot.lines() {
            let text = line.trim_start();
            let Some((pid, rest)) = text.split_once(char::is_whitespace) else {
                continue;
            };
            let Some((parent, remaining)) = rest.trim_start().split_once(char::is_whitespace)
            else {
                continue;
            };
            let (Ok(pid), Ok(parent)) = (pid.parse::<u32>(), parent.parse::<u32>()) else {
                continue;
            };
            let (session_id, remaining) = if has_session_column {
                let Some((session_id, remaining)) =
                    remaining.trim_start().split_once(char::is_whitespace)
                else {
                    continue;
                };
                let Ok(session_id) = session_id.parse::<u32>() else {
                    continue;
                };
                (session_id, remaining)
            } else {
                #[cfg(any(target_os = "macos", target_os = "ios"))]
                {
                    let session_id = match process_session_id(pid) {
                        Ok(Some(session_id)) => session_id,
                        Ok(None) => continue,
                        Err(_) => {
                            table.session_ids_incomplete = true;
                            0
                        }
                    };
                    (session_id, remaining)
                }
                #[cfg(not(any(target_os = "macos", target_os = "ios")))]
                {
                    unreachable!("OS session id resolution is Darwin-only")
                }
            };
            let remaining = remaining.trim_start();
            let (groups, command) = parse_terminal_process_groups(remaining)
                .map_or((None, remaining), |(groups, command)| {
                    (Some(groups), command)
                });
            table.children.entry(parent).or_default().push(pid);
            if let Some(groups) = groups {
                table.terminal_groups.insert(pid, groups);
            }
            if let Some(provider) = classify_agent(command) {
                table.agents.insert(pid, provider);
            }
            if table.records.len() < record_limit {
                table.records.push(ProcessRecord {
                    pid,
                    parent_pid: parent,
                    session_id,
                    command: bounded_process_command(command),
                });
            } else {
                table.records_truncated = true;
            }
        }
        table
    }

    fn nearest_agent(&self, root_pid: u32) -> Option<AgentCandidate> {
        let mut queue = VecDeque::from([root_pid]);
        let mut seen = HashSet::new();
        while let Some(pid) = queue.pop_front() {
            if !seen.insert(pid) {
                continue;
            }
            if let Some(provider) = self.agents.get(&pid) {
                return Some(AgentCandidate {
                    pid,
                    provider: *provider,
                });
            }
            if let Some(children) = self.children.get(&pid) {
                queue.extend(children.iter().copied());
            }
        }
        None
    }

    fn nearest_foreground(&self, root_pid: u32) -> Option<u32> {
        let mut queue = VecDeque::from([root_pid]);
        let mut seen = HashSet::new();
        while let Some(pid) = queue.pop_front() {
            if !seen.insert(pid) {
                continue;
            }
            if self.terminal_groups.get(&pid).is_some_and(|groups| {
                groups.process_group > 0
                    && groups.process_group == groups.foreground_process_group
                    && u32::try_from(groups.process_group) == Ok(pid)
            }) {
                return Some(pid);
            }
            if let Some(children) = self.children.get(&pid) {
                queue.extend(children.iter().copied());
            }
        }
        None
    }
}

fn parse_terminal_process_groups(input: &str) -> Option<(TerminalProcessGroups, &str)> {
    let (process_group, rest) = input.split_once(char::is_whitespace)?;
    let (foreground_process_group, command) = rest.trim_start().split_once(char::is_whitespace)?;
    Some((
        TerminalProcessGroups {
            process_group: process_group.parse().ok()?,
            foreground_process_group: foreground_process_group.parse().ok()?,
        },
        command.trim_start(),
    ))
}

fn bounded_process_command(command: &str) -> String {
    let mut end = command.len().min(MAX_COMMAND_BYTES);
    while !command.is_char_boundary(end) {
        end -= 1;
    }
    command[..end].to_string()
}

#[derive(Clone, Copy)]
struct AgentCandidate {
    pid: u32,
    provider: AgentProvider,
}

fn classify_agent(command: &str) -> Option<AgentProvider> {
    let mut tokens = command.split_whitespace();
    let executable = tokens.next()?;
    if let Some(provider) = lookup_executable(executable, Some(command)) {
        return Some(provider);
    }
    let runtime = executable.rsplit('/').next().unwrap_or(executable);
    if matches!(runtime, "node" | "nodejs" | "bun" | "deno") {
        return tokens
            .take(3)
            .find(|entrypoint| !entrypoint.starts_with('-'))
            .and_then(|entrypoint| lookup_executable(entrypoint, Some(command)));
    }
    if matches!(runtime, "sh" | "bash" | "zsh" | "dash") {
        let entrypoint = tokens.next()?;
        if !entrypoint.starts_with('-') {
            return lookup_executable(entrypoint, Some(command));
        }
    }
    None
}

/// `command`를 주면 부속 토큰 조건(rovodev 등)까지 확인한다.
fn lookup_executable(executable: &str, command: Option<&str>) -> Option<AgentProvider> {
    let basename = executable.rsplit('/').next().unwrap_or(executable);
    // codex는 플랫폼별 보조 실행 파일(codex-linux-sandbox 등)로도 뜬다.
    if basename == "codex" || basename.starts_with("codex-") {
        return Some(AgentProvider::Codex);
    }
    let entry = AGENT_BINARIES.iter().find(|spec| spec.name == basename)?;
    match entry.requires {
        None => Some(entry.provider),
        Some(token) => command
            .is_some_and(|line| line.split_whitespace().any(|part| part == token))
            .then_some(entry.provider),
    }
}

#[cfg(target_os = "macos")]
#[must_use]
pub fn process_cwd(pid: u32) -> Option<PathBuf> {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;

    let mut info: libc::proc_vnodepathinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as libc::c_int;
    let result = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDVNODEPATHINFO,
            0,
            (&mut info as *mut libc::proc_vnodepathinfo).cast(),
            size,
        )
    };
    if result != size {
        return None;
    }
    let bytes = unsafe {
        std::slice::from_raw_parts(
            info.pvi_cdir.vip_path.as_ptr().cast::<u8>(),
            libc::MAXPATHLEN as usize,
        )
    };
    let end = bytes.iter().position(|byte| *byte == 0)?;
    (end > 0).then(|| PathBuf::from(OsStr::from_bytes(&bytes[..end])))
}

#[cfg(target_os = "linux")]
#[must_use]
pub fn process_cwd(pid: u32) -> Option<PathBuf> {
    fs::read_link(format!("/proc/{pid}/cwd")).ok()
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
#[must_use]
pub fn process_cwd(_pid: u32) -> Option<PathBuf> {
    None
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn nul_separated_arguments(bytes: &[u8]) -> Option<Vec<String>> {
    bytes
        .split(|byte| *byte == 0)
        .filter(|argument| !argument.is_empty())
        .map(|argument| std::str::from_utf8(argument).ok().map(ToString::to_string))
        .collect()
}

#[cfg(target_os = "macos")]
fn macos_process_arguments(bytes: &[u8]) -> Option<Vec<String>> {
    let argc_bytes = bytes.get(..std::mem::size_of::<libc::c_int>())?;
    let argc = libc::c_int::from_ne_bytes(argc_bytes.try_into().ok()?);
    let argc = usize::try_from(argc).ok()?;
    let mut offset = std::mem::size_of::<libc::c_int>();

    offset += bytes.get(offset..)?.iter().position(|byte| *byte == 0)? + 1;
    while bytes.get(offset) == Some(&0) {
        offset += 1;
    }
    let arguments = nul_separated_arguments(bytes.get(offset..)?)?;
    (arguments.len() >= argc).then(|| arguments.into_iter().take(argc).collect())
}

/// Returns the exact OS argument vector for one live process. Callers use this
/// only as corroborating runtime evidence; unavailable or non-UTF-8 arguments
/// fail closed.
#[cfg(target_os = "macos")]
#[must_use]
pub fn process_argv(pid: u32) -> Option<Vec<String>> {
    let pid = libc::c_int::try_from(pid).ok()?;
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    let mut size = 0;
    let size_result = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            mib.len() as libc::c_uint,
            std::ptr::null_mut(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if size_result != 0 || size == 0 || size > MAX_PROCESS_ARGUMENT_BYTES {
        return None;
    }
    let mut bytes = vec![0_u8; size];
    let read_result = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            mib.len() as libc::c_uint,
            bytes.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if read_result != 0 || size == 0 || size > bytes.len() {
        return None;
    }
    bytes.truncate(size);
    macos_process_arguments(&bytes)
}

#[cfg(target_os = "linux")]
#[must_use]
pub fn process_argv(pid: u32) -> Option<Vec<String>> {
    let mut bytes = Vec::new();
    File::open(format!("/proc/{pid}/cmdline"))
        .ok()?
        .take(MAX_PROCESS_ARGUMENT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.is_empty() || bytes.len() > MAX_PROCESS_ARGUMENT_BYTES {
        return None;
    }
    nul_separated_arguments(&bytes)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
#[must_use]
pub fn process_argv(_pid: u32) -> Option<Vec<String>> {
    None
}

/// Read the exact argument vector for the sampled foreground process only
/// while its PID still names the same OS process instance.
#[must_use]
pub fn foreground_process_argv(process: ForegroundProcess) -> Option<Vec<String>> {
    if process_start_time(process.pid) != Some(process.start_time) {
        return None;
    }
    let arguments = process_argv(process.pid)?;
    (process_start_time(process.pid) == Some(process.start_time)).then_some(arguments)
}

/// Project an OpenSSH client argument vector to its remote destination.
///
/// Unknown options and transport-only modes fail closed so a background
/// tunnel or local query cannot masquerade as an interactive remote shell.
#[must_use]
pub fn ssh_target_from_argv(arguments: &[String]) -> Option<String> {
    let executable = arguments.first()?.rsplit('/').next()?;
    if executable != "ssh" {
        return None;
    }

    let mut index = 1;
    let mut login_name: Option<&str> = None;
    while index < arguments.len() {
        let argument = arguments[index].as_str();
        if argument == "--" {
            index += 1;
            break;
        }
        if argument == "-" || !argument.starts_with('-') {
            break;
        }

        let options = argument[1..].char_indices();
        for (offset, option) in options {
            if matches!(option, 'G' | 'N' | 'O' | 'Q' | 'V' | 'W') {
                return None;
            }
            if ssh_option_without_value(option) {
                continue;
            }
            if !ssh_option_requires_value(option) {
                return None;
            }

            let value_offset = 1 + offset + option.len_utf8();
            let attached = &argument[value_offset..];
            let value = if attached.is_empty() {
                index += 1;
                arguments.get(index)?.as_str()
            } else {
                attached
            };
            if value.is_empty() || value.chars().any(char::is_control) {
                return None;
            }
            if option == 'l' {
                login_name = Some(value);
            }
            break;
        }
        index += 1;
    }

    let destination = arguments.get(index)?.trim();
    if destination.is_empty()
        || destination.starts_with('-')
        || destination.len() > 512
        || destination
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return None;
    }
    let target = if let Some(login_name) =
        login_name.filter(|_| !destination.contains('@') && !destination.starts_with("ssh://"))
    {
        format!("{login_name}@{destination}")
    } else {
        destination.to_string()
    };
    (target.len() <= 512).then_some(target)
}

fn ssh_option_without_value(option: char) -> bool {
    matches!(
        option,
        '4' | '6'
            | 'A'
            | 'a'
            | 'C'
            | 'f'
            | 'g'
            | 'K'
            | 'k'
            | 'M'
            | 'n'
            | 'q'
            | 's'
            | 'T'
            | 't'
            | 'v'
            | 'X'
            | 'x'
            | 'Y'
            | 'y'
    )
}

fn ssh_option_requires_value(option: char) -> bool {
    matches!(
        option,
        'B' | 'b'
            | 'c'
            | 'D'
            | 'E'
            | 'e'
            | 'F'
            | 'I'
            | 'i'
            | 'J'
            | 'L'
            | 'l'
            | 'm'
            | 'o'
            | 'P'
            | 'p'
            | 'R'
            | 'S'
            | 'w'
    )
}

#[cfg(target_os = "linux")]
#[must_use]
pub fn process_start_time(pid: u32) -> Option<u64> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let after_name = stat.rsplit_once(')')?.1.trim_start();
    after_name
        .split_whitespace()
        .nth(19)?
        .parse::<u64>()
        .ok()
        .filter(|value| *value != 0)
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
#[must_use]
pub fn process_start_time(pid: u32) -> Option<u64> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    let result = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut info as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    };
    if result != size {
        return None;
    }
    info.pbi_start_tvsec
        .checked_mul(1_000_000)?
        .checked_add(info.pbi_start_tvusec)
        .filter(|value| *value != 0)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "ios")))]
#[must_use]
pub fn process_start_time(_pid: u32) -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct CountingSource {
        samples: AtomicUsize,
        table: ProcessTable,
    }

    impl ProcessSource for CountingSource {
        fn sample(&self) -> io::Result<ProcessTable> {
            self.samples.fetch_add(1, Ordering::SeqCst);
            Ok(self.table.clone())
        }
    }

    struct FailingSource {
        samples: AtomicUsize,
    }

    impl ProcessSource for FailingSource {
        fn sample(&self) -> io::Result<ProcessTable> {
            self.samples.fetch_add(1, Ordering::SeqCst);
            Err(io::Error::other("injected sample failure"))
        }
    }

    struct AppearingProcessSource {
        samples: AtomicUsize,
        pid: u32,
    }

    impl ProcessSource for AppearingProcessSource {
        fn sample(&self) -> io::Result<ProcessTable> {
            let sample = self.samples.fetch_add(1, Ordering::SeqCst);
            Ok(if sample == 0 {
                ProcessTable::default()
            } else {
                ProcessTable {
                    records: vec![ProcessRecord {
                        pid: self.pid,
                        parent_pid: 1,
                        session_id: self.pid,
                        command: "/bin/sh".into(),
                    }],
                    ..ProcessTable::default()
                }
            })
        }
    }

    struct BlockingRefreshSource {
        samples: AtomicUsize,
        table: ProcessTable,
        fail_refresh: bool,
        refresh_started: Mutex<Option<std::sync::mpsc::Sender<()>>>,
        release_refresh: Mutex<std::sync::mpsc::Receiver<()>>,
    }

    impl ProcessSource for BlockingRefreshSource {
        fn sample(&self) -> io::Result<ProcessTable> {
            if self.samples.fetch_add(1, Ordering::SeqCst) > 0 {
                if let Some(refresh_started) = self.refresh_started.lock().unwrap().take() {
                    refresh_started.send(()).unwrap();
                }
                self.release_refresh.lock().unwrap().recv().unwrap();
                if self.fail_refresh {
                    return Err(io::Error::other("injected fresh census failure"));
                }
            }
            Ok(self.table.clone())
        }
    }

    struct PanickingRefreshSource {
        samples: AtomicUsize,
        table: ProcessTable,
        refresh_started: Mutex<Option<std::sync::mpsc::Sender<()>>>,
        release_refresh: Mutex<std::sync::mpsc::Receiver<()>>,
    }

    impl ProcessSource for PanickingRefreshSource {
        fn sample(&self) -> io::Result<ProcessTable> {
            let sample = self.samples.fetch_add(1, Ordering::SeqCst);
            if sample == 1 {
                if let Some(refresh_started) = self.refresh_started.lock().unwrap().take() {
                    refresh_started.send(()).unwrap();
                }
                self.release_refresh.lock().unwrap().recv().unwrap();
                panic!("injected process census panic");
            }
            Ok(self.table.clone())
        }
    }

    #[test]
    fn process_tree_uses_the_nearest_real_agent_process() {
        let snapshot = "\
100 1 100 100 100 /bin/zsh -l
110 100 100 110 110 /bin/zsh -lic claude
120 110 100 120 120 /usr/bin/node /opt/codex/bin/codex
130 120 100 130 130 /opt/codex/bin/codex worker
";
        let table = ProcessTable::parse(snapshot);
        let agent = table.nearest_agent(100).unwrap();
        assert_eq!(agent.pid, 120);
        assert_eq!(agent.provider, AgentProvider::Codex);
        assert_eq!(classify_agent("/bin/zsh -lic claude"), None);
    }

    #[test]
    fn shell_script_entrypoints_are_agents_but_shell_commands_are_not() {
        assert_eq!(
            classify_agent("/bin/bash /opt/agents/claude"),
            Some(AgentProvider::Claude),
        );
        assert_eq!(
            classify_agent("/bin/sh /opt/agents/codex --resume session"),
            Some(AgentProvider::Codex),
        );
        assert_eq!(classify_agent("/bin/zsh -lc claude"), None);
    }

    #[test]
    fn foreground_process_follows_the_session_terminal_group() {
        let table = ProcessTable::parse(
            "\
88266 1 88266 88266 0 /app/session __serve term-desk -- zsh -l
88268 88266 88266 88268 26011 zsh -l
26011 88268 88266 26011 26011 ssh rts@211.181.122.124
",
        );

        assert_eq!(table.nearest_foreground(88268), Some(26011));
    }

    #[test]
    fn background_ssh_does_not_replace_the_local_foreground_shell() {
        let table = ProcessTable::parse(
            "\
100 1 100 100 100 zsh -l
110 100 100 110 100 ssh -N remote
",
        );

        assert_eq!(table.nearest_foreground(100), Some(100));
    }

    #[test]
    fn process_table_carries_session_ids_and_detects_record_truncation() {
        let table = ProcessTable::parse_with_record_limit(
            "\
100 1 100 100 100 zsh -l
110 100 100 110 100 ssh -N remote
",
            1,
        );

        assert_eq!(table.records.len(), 1);
        assert_eq!(table.records[0].session_id, 100);
        assert!(table.records_truncated);
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    #[test]
    fn darwin_process_table_resolves_the_posix_session_id_from_the_os() {
        let pid = std::process::id();
        let table = ProcessTable::parse_with_os_session_ids(&format!(
            "{pid} 1 {pid} {pid} /bin/test-process"
        ));

        assert!(!table.session_ids_incomplete);
        assert_eq!(table.records.len(), 1);
        assert_eq!(
            table.records[0].session_id,
            process_session_id(pid).unwrap().unwrap()
        );
        assert_ne!(table.records[0].session_id, 0);
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    #[test]
    fn darwin_process_session_lookup_distinguishes_disappearance_from_observation_failure() {
        assert_eq!(
            classify_process_session_id(Err(io::Error::from_raw_os_error(libc::ESRCH))).unwrap(),
            None
        );
        let error = classify_process_session_id(Err(io::Error::from_raw_os_error(libc::EPERM)))
            .unwrap_err();
        assert_eq!(error.raw_os_error(), Some(libc::EPERM));
    }

    #[cfg(any(target_os = "macos", target_os = "ios"))]
    #[test]
    fn darwin_process_table_skips_a_process_that_disappeared_after_ps() {
        let table = ProcessTable::parse_with_os_session_ids(
            "2147483647 1 2147483647 2147483647 /bin/already-gone",
        );

        assert!(table.records.is_empty());
        assert!(!table.session_ids_incomplete);
    }

    #[test]
    fn ssh_target_parser_handles_options_and_fails_closed() {
        let args = |values: &[&str]| {
            values
                .iter()
                .map(|value| (*value).to_string())
                .collect::<Vec<_>>()
        };

        assert_eq!(
            ssh_target_from_argv(&args(&["/usr/bin/ssh", "rts@211.181.122.124"])),
            Some("rts@211.181.122.124".into()),
        );
        assert_eq!(
            ssh_target_from_argv(&args(&[
                "ssh",
                "-vv",
                "-p",
                "2222",
                "-loperator",
                "build-box",
            ])),
            Some("operator@build-box".into()),
        );
        assert_eq!(
            ssh_target_from_argv(&args(&["ssh", "-o", "ServerAliveInterval=30", "desk-a"])),
            Some("desk-a".into()),
        );
        assert_eq!(
            ssh_target_from_argv(&args(&["ssh", "-N", "-L", "8080:localhost:80", "desk-a"])),
            None,
        );
        assert_eq!(
            ssh_target_from_argv(&args(&["ssh", "--unknown", "desk-a"])),
            None,
        );
        assert_eq!(ssh_target_from_argv(&args(&["ssh", "-p"])), None,);
    }

    #[test]
    fn every_agent_binary_and_wire_code_round_trips() {
        let mut providers = Vec::new();
        for spec in AGENT_BINARIES {
            let command = format!(
                "/opt/agents/{}{}",
                spec.name,
                spec.requires
                    .map_or(String::new(), |token| format!(" {token}")),
            );
            assert_eq!(classify_agent(&command), Some(spec.provider), "{command}");
            if !providers.contains(&spec.provider) {
                providers.push(spec.provider);
            }
        }

        assert_eq!(providers.len(), 27);
        let mut wire_codes = HashSet::new();
        for provider in providers {
            assert_eq!(AgentProvider::from_id(provider.as_str()), Some(provider));
            assert_eq!(
                AgentProvider::from_wire_code(provider.wire_code()),
                Some(provider),
            );
            assert!(wire_codes.insert(provider.wire_code()));
        }
    }

    #[test]
    fn process_snapshot_wire_round_trips_bounded_records() {
        let response = SamplerResponse::Snapshot(ProcessSnapshot {
            revision: 42,
            processes: vec![
                ProcessRecord {
                    pid: 10,
                    parent_pid: 1,
                    session_id: 10,
                    command: "/bin/zsh -l".into(),
                },
                ProcessRecord {
                    pid: 11,
                    parent_pid: 10,
                    session_id: 10,
                    command: "/opt/hmux attach dev".into(),
                },
            ],
        });

        let encoded = encode_response(response.clone()).unwrap();
        let header: [u8; RESPONSE_HEADER_BYTES] =
            encoded[..RESPONSE_HEADER_BYTES].try_into().unwrap();
        assert_eq!(
            decode_response(header, &encoded[RESPONSE_HEADER_BYTES..]).unwrap(),
            response
        );
    }

    #[test]
    fn foreground_process_wire_round_trips() {
        let response = SamplerResponse::Foreground(ForegroundProcess {
            pid: 26011,
            start_time: 42,
        });

        let encoded = encode_response(response.clone()).unwrap();
        let header: [u8; RESPONSE_HEADER_BYTES] =
            encoded[..RESPONSE_HEADER_BYTES].try_into().unwrap();
        assert_eq!(
            decode_response(header, &encoded[RESPONSE_HEADER_BYTES..]).unwrap(),
            response,
        );
    }

    #[test]
    fn oversized_unrelated_command_does_not_hide_valid_attach_records() {
        let oversized = "한".repeat(MAX_COMMAND_BYTES);
        let table = ProcessTable::parse(&format!(
            "\
2 1 2 2 2 /opt/unrelated {oversized}
10 1 10 10 10 /app/hebbian-session __serve term-1 -- zsh
11 10 10 11 11 /usr/local/bin/hmux attach healthy
"
        ));
        assert_eq!(table.records.len(), 3);
        assert!(table.records[0].command.len() <= MAX_COMMAND_BYTES);

        let encoded = encode_response(SamplerResponse::Snapshot(ProcessSnapshot {
            revision: 1,
            processes: table.records,
        }))
        .unwrap();
        let header: [u8; RESPONSE_HEADER_BYTES] =
            encoded[..RESPONSE_HEADER_BYTES].try_into().unwrap();
        let SamplerResponse::Snapshot(decoded) =
            decode_response(header, &encoded[RESPONSE_HEADER_BYTES..]).unwrap()
        else {
            panic!("snapshot response expected");
        };
        assert!(decoded.processes[1].command.contains("__serve term-1"));
        assert!(decoded.processes[2].command.contains("hmux attach healthy"));
    }

    #[test]
    fn failed_worker_spawns_drop_the_connection_receiver() {
        let sampler = Arc::new(SharedSamplerState::new(
            DEFAULT_FRESHNESS,
            Arc::new(CountingSource {
                samples: AtomicUsize::new(0),
                table: ProcessTable::default(),
            }),
        ));
        let (connections_tx, connections_rx) = sync_channel(1);

        let worker_count = spawn_sampler_workers(
            connections_rx,
            sampler,
            |_worker_index, _receiver, _sampler| {
                Err(io::Error::other("injected worker spawn failure"))
            },
        );

        assert_eq!(worker_count, 0);
        let (stream, _peer) = UnixStream::pair().unwrap();
        assert!(matches!(
            connections_tx.try_send(stream),
            Err(TrySendError::Disconnected(_))
        ));
    }

    #[test]
    fn oversized_snapshot_payload_is_rejected_before_allocation() {
        let mut header = [0_u8; RESPONSE_HEADER_BYTES];
        header[..4].copy_from_slice(RESPONSE_MAGIC);
        header[4] = STATUS_SNAPSHOT;
        header[8..12].copy_from_slice(
            &u32::try_from(MAX_RESPONSE_PAYLOAD_BYTES + 1)
                .unwrap()
                .to_be_bytes(),
        );

        let error = declared_response_payload_bytes(header).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn clients_share_one_fresh_process_sample() {
        let runtime = tempfile::tempdir().unwrap();
        let pid = std::process::id();
        let source = Arc::new(CountingSource {
            samples: AtomicUsize::new(0),
            table: ProcessTable {
                children: HashMap::new(),
                agents: HashMap::from([(pid, AgentProvider::Codex)]),
                terminal_groups: HashMap::new(),
                records: vec![ProcessRecord {
                    pid,
                    parent_pid: 1,
                    session_id: pid,
                    command: "/opt/agents/codex".into(),
                }],
                records_truncated: false,
                session_ids_incomplete: false,
            },
        });
        let first = SharedProcessSampler::with_source(
            runtime.path().to_path_buf(),
            Duration::from_secs(30),
            source.clone(),
        )
        .unwrap();
        let second = SharedProcessSampler::with_source(
            runtime.path().to_path_buf(),
            Duration::from_secs(30),
            source.clone(),
        )
        .unwrap();

        assert_eq!(
            first.agent_process(pid).unwrap().unwrap().provider,
            AgentProvider::Codex
        );
        assert_eq!(
            second.agent_process(pid).unwrap().unwrap().provider,
            AgentProvider::Codex
        );
        let snapshot = second.process_snapshot().unwrap();
        assert_eq!(snapshot.revision, 1);
        assert_eq!(snapshot.processes.len(), 1);
        assert_eq!(snapshot.processes[0].pid, pid);
        assert_eq!(snapshot.processes[0].session_id, pid);
        assert_eq!(source.samples.load(Ordering::SeqCst), 1);

        let fresh = second.fresh_process_snapshot().unwrap();
        assert_eq!(fresh.revision, 2);
        assert_eq!(source.samples.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn recovered_peer_reunites_previously_private_clients() {
        let runtime = tempfile::tempdir().unwrap();
        let source = Arc::new(CountingSource {
            samples: AtomicUsize::new(0),
            table: ProcessTable::parse(""),
        });
        let clients: Vec<_> = (0..MAX_SAMPLER_WORKERS * 2)
            .map(|_| {
                SharedProcessSampler::with_source(
                    runtime.path().to_path_buf(),
                    Duration::from_secs(30),
                    source.clone(),
                )
                .unwrap()
            })
            .collect();
        for client in &clients {
            // Inject the transport's classified timeout, not an unavailable
            // process result. All subsequent requests use the real client.
            for _ in 0..MAX_UNRESPONSIVE_ATTEMPTS {
                client
                    .degrade(&io::Error::new(io::ErrorKind::TimedOut, "peer outage"))
                    .unwrap();
            }
            assert!(client.process_snapshot().is_ok());
            assert!(client.degraded_peer_reason().is_some());
        }
        assert_eq!(source.samples.load(Ordering::SeqCst), clients.len());

        // A new, healthy client takes ownership normally; old clients must
        // rejoin it without a restart or replacement of its live socket.
        let healthy = SharedProcessSampler::with_source(
            runtime.path().to_path_buf(),
            Duration::from_secs(30),
            source.clone(),
        )
        .unwrap();
        assert!(healthy.process_snapshot().is_ok());
        thread::sleep(Duration::from_secs(31));
        assert!(healthy.process_snapshot().is_ok());
        let samples_before_recovery = source.samples.load(Ordering::SeqCst);
        for client in &clients {
            assert!(client.process_snapshot().is_ok());
        }
        assert_eq!(
            source.samples.load(Ordering::SeqCst),
            samples_before_recovery,
            "recovered clients must reuse the shared census, not each sample privately",
        );
        for client in &clients {
            assert!(client.degraded_peer_reason().is_none());
        }
    }

    #[test]
    fn more_than_one_worker_batch_shares_one_recent_complete_census() {
        const CALLERS: usize = MAX_SAMPLER_WORKERS * 4;

        let runtime = tempfile::tempdir().unwrap();
        let pid = std::process::id();
        let (refresh_started_tx, refresh_started_rx) = std::sync::mpsc::channel();
        let (release_refresh_tx, release_refresh_rx) = std::sync::mpsc::channel();
        let source = Arc::new(BlockingRefreshSource {
            samples: AtomicUsize::new(0),
            table: ProcessTable {
                records: vec![ProcessRecord {
                    pid,
                    parent_pid: 1,
                    session_id: pid,
                    command: "/bin/sh".into(),
                }],
                ..ProcessTable::default()
            },
            fail_refresh: false,
            refresh_started: Mutex::new(Some(refresh_started_tx)),
            release_refresh: Mutex::new(release_refresh_rx),
        });
        let sampler = SharedProcessSampler::with_source(
            runtime.path().to_path_buf(),
            Duration::from_secs(30),
            source.clone(),
        )
        .unwrap();
        assert_eq!(sampler.process_snapshot().unwrap().revision, 1);
        thread::sleep(Duration::from_millis(300));

        let barrier = Arc::new(std::sync::Barrier::new(CALLERS + 1));
        let callers = (0..CALLERS)
            .map(|_| {
                let sampler = sampler.clone();
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    barrier.wait();
                    sampler.complete_process_snapshot_containing(pid, Duration::from_millis(250))
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        refresh_started_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        thread::sleep(Duration::from_millis(50));
        release_refresh_tx.send(()).unwrap();

        for caller in callers {
            assert_eq!(caller.join().unwrap().unwrap().revision, 2);
        }
        assert_eq!(source.samples.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn explicit_fresh_snapshots_never_reuse_the_freshness_cache() {
        let source = Arc::new(CountingSource {
            samples: AtomicUsize::new(0),
            table: ProcessTable::default(),
        });
        let state = SharedSamplerState::new(Duration::from_secs(30), source.clone());

        assert_eq!(state.process_snapshot().unwrap().revision, 1);
        assert_eq!(state.process_snapshot().unwrap().revision, 1);
        assert_eq!(state.fresh_process_snapshot().unwrap().revision, 2);
        assert_eq!(state.fresh_process_snapshot().unwrap().revision, 3);
        assert_eq!(source.samples.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn explicit_fresh_snapshot_fails_closed_after_record_truncation() {
        let source = Arc::new(CountingSource {
            samples: AtomicUsize::new(0),
            table: ProcessTable {
                records_truncated: true,
                ..ProcessTable::default()
            },
        });
        let state = SharedSamplerState::new(Duration::from_secs(30), source.clone());

        // Preserve the existing observational API: cached callers still get
        // the bounded projection they got before this safety API existed.
        assert!(state.process_snapshot().is_ok());
        let error = state.fresh_process_snapshot().unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert_eq!(source.samples.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn complete_census_rejects_a_recent_snapshot_from_before_the_required_process() {
        let source = Arc::new(AppearingProcessSource {
            samples: AtomicUsize::new(0),
            pid: 42,
        });
        let state = SharedSamplerState::new(Duration::from_secs(30), source.clone());

        assert_eq!(state.process_snapshot().unwrap().revision, 1);
        let complete = state
            .complete_process_snapshot_containing(42, MAX_COMPLETE_SNAPSHOT_AGE)
            .unwrap();
        assert_eq!(complete.revision, 2);
        assert!(complete.processes.iter().any(|process| process.pid == 42));
        assert_eq!(
            state
                .complete_process_snapshot_containing(42, MAX_COMPLETE_SNAPSHOT_AGE)
                .unwrap()
                .revision,
            2
        );
        assert_eq!(source.samples.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn complete_census_never_reuses_an_incomplete_snapshot() {
        let source = Arc::new(CountingSource {
            samples: AtomicUsize::new(0),
            table: ProcessTable {
                records: vec![ProcessRecord {
                    pid: 42,
                    parent_pid: 1,
                    session_id: 42,
                    command: "/bin/sh".into(),
                }],
                records_truncated: true,
                ..ProcessTable::default()
            },
        });
        let state = SharedSamplerState::new(Duration::from_secs(30), source.clone());

        assert_eq!(state.process_snapshot().unwrap().revision, 1);
        let error = state
            .complete_process_snapshot_containing(42, MAX_COMPLETE_SNAPSHOT_AGE)
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert_eq!(source.samples.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn non_reading_snapshot_client_does_not_block_agent_requests() {
        let runtime = tempfile::tempdir().unwrap();
        let pid = std::process::id();
        let mut records = (0..4_096)
            .map(|index| ProcessRecord {
                pid: 100_000 + index,
                parent_pid: 1,
                session_id: 100_000,
                command: format!("/opt/unrelated {}", "x".repeat(1_024)),
            })
            .collect::<Vec<_>>();
        records.push(ProcessRecord {
            pid,
            parent_pid: 1,
            session_id: pid,
            command: "/opt/agents/codex".into(),
        });
        let source = Arc::new(CountingSource {
            samples: AtomicUsize::new(0),
            table: ProcessTable {
                children: HashMap::new(),
                agents: HashMap::from([(pid, AgentProvider::Codex)]),
                terminal_groups: HashMap::new(),
                records,
                records_truncated: false,
                session_ids_incomplete: false,
            },
        });
        let first = SharedProcessSampler::with_source(
            runtime.path().to_path_buf(),
            Duration::from_secs(30),
            source.clone(),
        )
        .unwrap();
        let second = SharedProcessSampler::with_source(
            runtime.path().to_path_buf(),
            Duration::from_secs(30),
            source,
        )
        .unwrap();
        assert!(first.agent_process(pid).unwrap().is_some());

        let mut slow_client = UnixStream::connect(&first.paths.socket).unwrap();
        slow_client
            .write_all(&encode_request(SamplerRequest::Snapshot))
            .unwrap();
        slow_client
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        let mut attestation = [0_u8; ATTESTATION_BYTES];
        slow_client.read_exact(&mut attestation).unwrap();
        assert_eq!(attestation, encode_attestation());
        let mut header = [0_u8; RESPONSE_HEADER_BYTES];
        slow_client.read_exact(&mut header).unwrap();
        assert!(declared_response_payload_bytes(header).unwrap() > 1_000_000);

        let started = Instant::now();
        assert!(second.agent_process(pid).unwrap().is_some());
        assert!(started.elapsed() < Duration::from_millis(1_500));
    }

    #[test]
    fn process_census_runs_outside_the_shared_state_lock() {
        let pid = std::process::id();
        let (refresh_started_tx, refresh_started_rx) = std::sync::mpsc::channel();
        let (release_refresh_tx, release_refresh_rx) = std::sync::mpsc::channel();
        let source = Arc::new(BlockingRefreshSource {
            samples: AtomicUsize::new(0),
            table: ProcessTable {
                children: HashMap::new(),
                agents: HashMap::from([(pid, AgentProvider::Codex)]),
                terminal_groups: HashMap::new(),
                records: vec![ProcessRecord {
                    pid,
                    parent_pid: 1,
                    session_id: pid,
                    command: "/opt/agents/codex".into(),
                }],
                records_truncated: false,
                session_ids_incomplete: false,
            },
            fail_refresh: false,
            refresh_started: Mutex::new(Some(refresh_started_tx)),
            release_refresh: Mutex::new(release_refresh_rx),
        });
        let state = Arc::new(SharedSamplerState::new(Duration::ZERO, source.clone()));
        assert!(state.agent_process(pid).unwrap().is_some());

        let refresh_state = Arc::clone(&state);
        let refresh = thread::spawn(move || refresh_state.process_snapshot());
        refresh_started_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap();

        let (agent_result_tx, agent_result_rx) = std::sync::mpsc::channel();
        let agent_state = Arc::clone(&state);
        let agent = thread::spawn(move || {
            agent_result_tx
                .send(agent_state.agent_process(pid))
                .unwrap();
        });
        let agent_result = agent_result_rx.recv_timeout(Duration::from_secs(1));
        release_refresh_tx.send(()).unwrap();
        assert!(agent_result.unwrap().unwrap().is_some());
        agent.join().unwrap();
        assert!(refresh.join().unwrap().is_ok());
        assert_eq!(source.samples.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn concurrent_fresh_census_fails_instead_of_returning_cached_records() {
        let (refresh_started_tx, refresh_started_rx) = std::sync::mpsc::channel();
        let (release_refresh_tx, release_refresh_rx) = std::sync::mpsc::channel();
        let source = Arc::new(BlockingRefreshSource {
            samples: AtomicUsize::new(0),
            table: ProcessTable::default(),
            fail_refresh: false,
            refresh_started: Mutex::new(Some(refresh_started_tx)),
            release_refresh: Mutex::new(release_refresh_rx),
        });
        let state = Arc::new(SharedSamplerState::new(
            Duration::from_secs(30),
            source.clone(),
        ));
        assert_eq!(state.process_snapshot().unwrap().revision, 1);

        let refresh_state = Arc::clone(&state);
        let refresh = thread::spawn(move || refresh_state.fresh_process_snapshot());
        refresh_started_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap();

        let error = state.fresh_process_snapshot().unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::WouldBlock);
        release_refresh_tx.send(()).unwrap();
        assert_eq!(refresh.join().unwrap().unwrap().revision, 2);
        assert_eq!(source.samples.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn concurrent_complete_census_never_reuses_cached_records_after_failure() {
        let (refresh_started_tx, refresh_started_rx) = std::sync::mpsc::channel();
        let (release_refresh_tx, release_refresh_rx) = std::sync::mpsc::channel();
        let source = Arc::new(BlockingRefreshSource {
            samples: AtomicUsize::new(0),
            table: ProcessTable::default(),
            fail_refresh: true,
            refresh_started: Mutex::new(Some(refresh_started_tx)),
            release_refresh: Mutex::new(release_refresh_rx),
        });
        let state = Arc::new(SharedSamplerState::new(
            Duration::from_secs(30),
            source.clone(),
        ));
        assert_eq!(state.process_snapshot().unwrap().revision, 1);
        thread::sleep(Duration::from_millis(5));

        let refresh_state = Arc::clone(&state);
        let refresh = thread::spawn(move || {
            refresh_state.complete_process_snapshot_containing(42, Duration::from_millis(1))
        });
        refresh_started_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap();

        let concurrent_state = Arc::clone(&state);
        let concurrent = thread::spawn(move || {
            concurrent_state.complete_process_snapshot_containing(42, Duration::from_millis(1))
        });
        thread::sleep(Duration::from_millis(20));
        assert!(!concurrent.is_finished());
        release_refresh_tx.send(()).unwrap();

        assert!(refresh.join().unwrap().is_err());
        assert!(concurrent.join().unwrap().is_err());
        assert_eq!(source.samples.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn panicking_complete_census_releases_waiters_and_allows_recovery() {
        let (refresh_started_tx, refresh_started_rx) = std::sync::mpsc::channel();
        let (release_refresh_tx, release_refresh_rx) = std::sync::mpsc::channel();
        let source = Arc::new(PanickingRefreshSource {
            samples: AtomicUsize::new(0),
            table: ProcessTable {
                records: vec![ProcessRecord {
                    pid: 42,
                    parent_pid: 1,
                    session_id: 42,
                    command: "/bin/sh".into(),
                }],
                ..ProcessTable::default()
            },
            refresh_started: Mutex::new(Some(refresh_started_tx)),
            release_refresh: Mutex::new(release_refresh_rx),
        });
        let state = Arc::new(SharedSamplerState::new(
            Duration::from_secs(30),
            source.clone(),
        ));
        assert_eq!(state.process_snapshot().unwrap().revision, 1);
        thread::sleep(Duration::from_millis(5));

        let refresh_state = Arc::clone(&state);
        let refresh = thread::spawn(move || {
            refresh_state.complete_process_snapshot_containing(42, Duration::from_millis(1))
        });
        refresh_started_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        let waiter_state = Arc::clone(&state);
        let waiter = thread::spawn(move || {
            waiter_state.complete_process_snapshot_containing(42, Duration::from_millis(1))
        });
        thread::sleep(Duration::from_millis(20));
        assert!(!waiter.is_finished());
        release_refresh_tx.send(()).unwrap();

        assert!(refresh.join().unwrap().is_err());
        assert!(waiter.join().unwrap().is_err());
        assert_eq!(
            state
                .complete_process_snapshot_containing(42, MAX_COMPLETE_SNAPSHOT_AGE)
                .unwrap()
                .revision,
            2
        );
        assert_eq!(source.samples.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn complete_census_wait_is_bounded_and_does_not_stick_the_sampler() {
        let (refresh_started_tx, refresh_started_rx) = std::sync::mpsc::channel();
        let (release_refresh_tx, release_refresh_rx) = std::sync::mpsc::channel();
        let source = Arc::new(BlockingRefreshSource {
            samples: AtomicUsize::new(0),
            table: ProcessTable {
                records: vec![ProcessRecord {
                    pid: 42,
                    parent_pid: 1,
                    session_id: 42,
                    command: "/bin/sh".into(),
                }],
                ..ProcessTable::default()
            },
            fail_refresh: false,
            refresh_started: Mutex::new(Some(refresh_started_tx)),
            release_refresh: Mutex::new(release_refresh_rx),
        });
        let state = Arc::new(SharedSamplerState::new(
            Duration::from_secs(30),
            source.clone(),
        ));
        assert_eq!(state.process_snapshot().unwrap().revision, 1);
        thread::sleep(Duration::from_millis(5));

        let refresh_state = Arc::clone(&state);
        let refresh = thread::spawn(move || refresh_state.fresh_process_snapshot());
        refresh_started_rx
            .recv_timeout(Duration::from_secs(1))
            .unwrap();

        let started = Instant::now();
        let error = state
            .complete_process_snapshot_containing(42, Duration::from_millis(1))
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() < IO_TIMEOUT);

        release_refresh_tx.send(()).unwrap();
        assert_eq!(refresh.join().unwrap().unwrap().revision, 2);
        assert_eq!(
            state
                .complete_process_snapshot_containing(42, MAX_COMPLETE_SNAPSHOT_AGE)
                .unwrap()
                .revision,
            2
        );
        assert_eq!(source.samples.load(Ordering::SeqCst), 2);
    }

    /// A sampler whose peer is whatever `answer` writes back.
    ///
    /// Both shapes this simulates are live on this machine right now: a daemon
    /// from an older build that reads the frame, cannot decode it and closes,
    /// and a peer that accepts and then never speaks.
    fn sampler_behind_peer(
        runtime: &tempfile::TempDir,
        answer: impl Fn(UnixStream) + Send + 'static,
    ) -> SharedProcessSampler {
        let pid = std::process::id();
        let paths = SamplerPaths::prepare(runtime.path().to_path_buf()).unwrap();
        let listener = UnixListener::bind(&paths.socket).unwrap();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else {
                    continue;
                };
                // Consume the request exactly as an older daemon does, so the
                // client's write always succeeds and the failure lands where
                // this test aims it: on the missing attestation.
                let mut request = [0_u8; REQUEST_BYTES];
                let _ = read_exact_before(&mut stream, &mut request, Instant::now() + IO_TIMEOUT);
                answer(stream);
            }
        });
        SharedProcessSampler::with_source(
            runtime.path().to_path_buf(),
            Duration::from_secs(30),
            Arc::new(CountingSource {
                samples: AtomicUsize::new(0),
                table: ProcessTable {
                    children: HashMap::new(),
                    agents: HashMap::from([(pid, AgentProvider::Codex)]),
                    terminal_groups: HashMap::new(),
                    records: vec![ProcessRecord {
                        pid,
                        parent_pid: 1,
                        session_id: pid,
                        command: "/opt/agents/codex".into(),
                    }],
                    records_truncated: false,
                    session_ids_incomplete: false,
                },
            }),
        )
        .unwrap()
    }

    #[test]
    fn socket_path_and_frames_agree_on_one_protocol_version() {
        let runtime = tempfile::tempdir().unwrap();
        let paths = SamplerPaths::prepare(runtime.path().to_path_buf()).unwrap();

        // The whole failure began with a path that said v2 over framing that
        // said v1. Nothing may be able to move one without the other again.
        assert_eq!(
            paths.socket.file_name().unwrap(),
            format!("process-sampler-v{PROTOCOL_VERSION}.sock").as_str()
        );
        assert_eq!(
            paths.lock.file_name().unwrap(),
            format!("process-sampler-v{PROTOCOL_VERSION}.lock").as_str()
        );
        let request = encode_request(SamplerRequest::Agent(std::process::id()));
        assert_eq!(&request[4..8], PROTOCOL_VERSION.to_be_bytes());
        assert_eq!(&encode_attestation()[4..8], PROTOCOL_VERSION.to_be_bytes());
        assert_eq!(
            decode_request(encode_request(SamplerRequest::FreshSnapshot)).unwrap(),
            SamplerRequest::FreshSnapshot,
        );
        assert_eq!(
            decode_request(encode_request(SamplerRequest::CompleteSnapshot {
                required_pid: 42,
                max_age_ms: 250,
            }))
            .unwrap(),
            SamplerRequest::CompleteSnapshot {
                required_pid: 42,
                max_age_ms: 250,
            },
        );
        assert_eq!(
            complete_snapshot_max_age_ms(Duration::from_nanos(1))
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput,
        );

        let mut foreign = request;
        foreign[4..8].copy_from_slice(&(PROTOCOL_VERSION + 1).to_be_bytes());
        assert_eq!(
            decode_request(foreign).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn peer_that_cannot_attest_is_named_and_never_starves_the_caller() {
        let runtime = tempfile::tempdir().unwrap();
        let sampler = sampler_behind_peer(&runtime, drop);
        let started = Instant::now();

        assert_eq!(
            sampler
                .agent_process(std::process::id())
                .unwrap()
                .unwrap()
                .provider,
            AgentProvider::Codex
        );
        // Instant, not "eventually": the old code returned UnexpectedEof here,
        // callers flattened it to None, and the caller polled forever.
        assert!(started.elapsed() < IO_TIMEOUT);
        let reason = sampler.degraded_peer_reason().unwrap();
        assert!(reason.contains(&sampler.paths.socket.display().to_string()));
        assert!(reason.contains("without attesting a protocol version"));
        assert!(sampler.process_snapshot().unwrap().revision > 0);
    }

    #[test]
    fn peer_serving_another_protocol_version_says_which() {
        let runtime = tempfile::tempdir().unwrap();
        let sampler = sampler_behind_peer(&runtime, |mut stream| {
            let mut attestation = encode_attestation();
            attestation[4..8].copy_from_slice(&(PROTOCOL_VERSION + 1).to_be_bytes());
            let _ = stream.write_all(&attestation);
        });

        assert!(sampler.agent_process(std::process::id()).unwrap().is_some());
        let reason = sampler.degraded_peer_reason().unwrap();
        assert!(
            reason.contains(&format!("serves protocol v{}", PROTOCOL_VERSION + 1)),
            "{reason}"
        );
    }

    #[test]
    fn wedged_peer_is_retried_then_demoted_instead_of_stalling_every_call() {
        let runtime = tempfile::tempdir().unwrap();
        let sampler = sampler_behind_peer(&runtime, |stream| {
            // Accept, hold the connection open, and never answer.
            thread::spawn(move || thread::sleep(Duration::from_secs(30) * 2 + IO_TIMEOUT * 2));
            std::mem::forget(stream);
        });

        for attempt in 1..=MAX_UNRESPONSIVE_ATTEMPTS {
            assert!(
                sampler.agent_process(std::process::id()).unwrap().is_some(),
                "attempt {attempt} starved the caller"
            );
        }
        // A wedged peer gets its retries, but not an unbounded supply of them:
        // each one costs IO_TIMEOUT and produces nothing.
        let reason = sampler.degraded_peer_reason().unwrap();
        assert!(reason.contains("frame deadline expired"), "{reason}");
        let started = Instant::now();
        assert!(sampler.agent_process(std::process::id()).unwrap().is_some());
        assert!(started.elapsed() < IO_TIMEOUT);
    }

    #[test]
    fn one_recovery_probe_serves_clones_locally_until_the_peer_answers() {
        let runtime = tempfile::tempdir().unwrap();
        let requests = Arc::new(AtomicUsize::new(0));
        let peer_requests = Arc::clone(&requests);
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let sampler = sampler_behind_peer(&runtime, move |mut stream| {
            if peer_requests.fetch_add(1, Ordering::SeqCst) == 0 {
                return;
            }
            started_tx.send(()).unwrap();
            if release_rx.recv_timeout(IO_TIMEOUT).is_err() {
                return;
            }
            stream.write_all(&encode_attestation()).unwrap();
            stream
                .write_all(
                    &encode_response(SamplerResponse::Snapshot(ProcessSnapshot {
                        revision: 99,
                        processes: vec![],
                    }))
                    .unwrap(),
                )
                .unwrap();
        });
        assert_eq!(sampler.process_snapshot().unwrap().revision, 1);
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        *sampler.fallback.retry_after.lock().unwrap() = Some(Instant::now());

        thread::scope(|scope| {
            let probe = scope.spawn(|| sampler.process_snapshot().unwrap());
            started_rx.recv_timeout(IO_TIMEOUT).unwrap();
            for _ in 0..MAX_SAMPLER_WORKERS * 2 {
                assert_eq!(sampler.clone().process_snapshot().unwrap().revision, 1);
            }
            assert_eq!(requests.load(Ordering::SeqCst), 2);
            assert!(sampler.degraded_peer_reason().is_some());
            release_tx.send(()).unwrap();
            assert_eq!(probe.join().unwrap().revision, 99);
        });
        assert!(sampler.degraded_peer_reason().is_none());
        assert!(sampler.fallback.state.lock().unwrap().is_none());
    }

    #[test]
    fn unsuccessful_recovery_probe_renews_the_local_observation_window() {
        let runtime = tempfile::tempdir().unwrap();
        let requests = Arc::new(AtomicUsize::new(0));
        let peer_requests = Arc::clone(&requests);
        let sampler = sampler_behind_peer(&runtime, move |_| {
            peer_requests.fetch_add(1, Ordering::SeqCst);
        });
        assert!(sampler.process_snapshot().is_ok());
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        *sampler.fallback.retry_after.lock().unwrap() = Some(Instant::now());
        assert!(sampler.process_snapshot().is_ok());
        assert_eq!(requests.load(Ordering::SeqCst), 2);
        for _ in 0..MAX_SAMPLER_WORKERS * 2 {
            assert!(sampler.process_snapshot().is_ok());
        }
        assert_eq!(requests.load(Ordering::SeqCst), 2);
        assert!(sampler.degraded_peer_reason().is_some());
    }

    #[test]
    fn stale_socket_is_replaced_under_the_startup_lock() {
        let runtime = tempfile::tempdir().unwrap();
        let paths = SamplerPaths::prepare(runtime.path().to_path_buf()).unwrap();
        drop(UnixListener::bind(&paths.socket).unwrap());

        let sampler = SharedProcessSampler::with_runtime_dir(runtime.path().to_path_buf()).unwrap();
        assert_eq!(sampler.agent_process(std::process::id()).unwrap(), None);
    }

    #[test]
    fn sample_failures_are_coalesced_for_the_freshness_window() {
        let source = Arc::new(FailingSource {
            samples: AtomicUsize::new(0),
        });
        let state = SharedSamplerState::new(Duration::from_secs(30), source.clone());

        assert!(state.agent_process(std::process::id()).is_err());
        assert!(state.agent_process(std::process::id()).is_err());
        assert!(state.process_snapshot().is_err());
        assert_eq!(source.samples.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn unsafe_socket_paths_are_never_replaced() {
        let runtime = tempfile::tempdir().unwrap();
        let paths = SamplerPaths::prepare(runtime.path().to_path_buf()).unwrap();
        File::create(&paths.socket).unwrap();
        let sampler = SharedProcessSampler::with_runtime_dir(runtime.path().to_path_buf()).unwrap();

        let error = sampler.agent_process(std::process::id()).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(paths.socket.is_file());
    }

    #[test]
    fn symlink_runtime_directory_is_rejected() {
        let parent = tempfile::tempdir().unwrap();
        let target = tempfile::tempdir().unwrap();
        let link = parent.path().join("runtime-link");
        std::os::unix::fs::symlink(target.path(), &link).unwrap();

        let error = SharedProcessSampler::with_runtime_dir(link).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn current_process_has_a_stable_nonzero_start_time() {
        let pid = std::process::id();
        let first = process_start_time(pid).unwrap();
        assert_ne!(first, 0);
        assert_eq!(process_start_time(pid), Some(first));
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn current_process_cwd_matches_the_os_projection() {
        let expected = fs::canonicalize(std::env::current_dir().unwrap()).unwrap();
        let observed = fs::canonicalize(process_cwd(std::process::id()).unwrap()).unwrap();
        assert_eq!(observed, expected);
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn current_process_arguments_match_the_test_binary() {
        let arguments = process_argv(std::process::id()).unwrap();
        assert!(!arguments.is_empty());
        assert!(arguments[0].contains("hebbian_process_sampler"));
    }

    #[test]
    fn nul_separated_arguments_reject_non_utf8_input() {
        assert_eq!(
            nul_separated_arguments(b"codex\0resume\0thread\0"),
            Some(vec!["codex".into(), "resume".into(), "thread".into()])
        );
        assert_eq!(nul_separated_arguments(b"codex\0\xff\0"), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_arguments_stop_at_argc_before_the_environment() {
        let mut bytes = (3_i32).to_ne_bytes().to_vec();
        bytes.extend_from_slice(b"/bin/codex\0\0codex\0resume\0thread\0SPOOFED=resume\0");
        assert_eq!(
            macos_process_arguments(&bytes),
            Some(vec!["codex".into(), "resume".into(), "thread".into()])
        );
    }
}
