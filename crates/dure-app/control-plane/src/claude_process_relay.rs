use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::io::{self, Read, Write};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender, TryRecvError, sync_channel};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Map, Value, json};

const MAGIC: &[u8; 4] = b"DCR1";
const PREFIX_BYTES: usize = 20;
const MAX_FRAME_BYTES: usize = 256 * 1024;
const MAX_METADATA_BYTES: usize = 16 * 1024;
const MAX_STREAM_BYTES: usize = 64 * 1024;
const MAX_STDERR_BYTES: usize = 2 * 1024;
const HOST_EVENT_CAPACITY: usize = 16;
const CHILD_EXIT_GRACE: Duration = Duration::from_secs(2);
const POLL_INTERVAL: Duration = Duration::from_millis(10);

#[derive(Debug)]
pub struct RelayError {
    reason: String,
}

impl RelayError {
    fn contract(reason: impl Into<String>) -> Self {
        Self {
            reason: format!("dure_claude_process_relay_{}", reason.into()),
        }
    }
}

impl std::fmt::Display for RelayError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.reason)
    }
}

impl std::error::Error for RelayError {}

impl From<io::Error> for RelayError {
    fn from(_: io::Error) -> Self {
        Self::contract("io_failed")
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct RelayIdentity {
    runtime_generation: String,
    query_epoch: String,
    relay_id: String,
}

impl RelayIdentity {
    fn new(
        runtime_generation: String,
        query_epoch: String,
        relay_id: String,
    ) -> Result<Self, RelayError> {
        for (label, value) in [
            ("runtime_generation", &runtime_generation),
            ("query_epoch", &query_epoch),
            ("relay_id", &relay_id),
        ] {
            if value.is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
                return Err(RelayError::contract(format!("{label}_invalid")));
            }
        }
        Ok(Self {
            runtime_generation,
            query_epoch,
            relay_id,
        })
    }

    fn from_metadata(metadata: &Map<String, Value>) -> Result<Self, RelayError> {
        Self::new(
            metadata_string(metadata, "runtimeGeneration")?.to_owned(),
            metadata_string(metadata, "queryEpoch")?.to_owned(),
            metadata_string(metadata, "relayId")?.to_owned(),
        )
    }

    fn insert_into(&self, metadata: &mut Map<String, Value>) {
        metadata.insert(
            "runtimeGeneration".into(),
            Value::String(self.runtime_generation.clone()),
        );
        metadata.insert("queryEpoch".into(), Value::String(self.query_epoch.clone()));
        metadata.insert("relayId".into(), Value::String(self.relay_id.clone()));
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
enum FrameKind {
    Hello = 1,
    Ready = 2,
    Stdin = 3,
    StdinAck = 4,
    StdinEof = 5,
    StdinEofAck = 6,
    Stdout = 7,
    StdoutAck = 8,
    StdoutEof = 9,
    Signal = 10,
    SignalAck = 11,
    Exit = 12,
    Error = 13,
    Abort = 14,
    AbortAck = 15,
}

impl TryFrom<u8> for FrameKind {
    type Error = RelayError;

    fn try_from(value: u8) -> Result<Self, RelayError> {
        match value {
            1 => Ok(Self::Hello),
            2 => Ok(Self::Ready),
            3 => Ok(Self::Stdin),
            4 => Ok(Self::StdinAck),
            5 => Ok(Self::StdinEof),
            6 => Ok(Self::StdinEofAck),
            7 => Ok(Self::Stdout),
            8 => Ok(Self::StdoutAck),
            9 => Ok(Self::StdoutEof),
            10 => Ok(Self::Signal),
            11 => Ok(Self::SignalAck),
            12 => Ok(Self::Exit),
            13 => Ok(Self::Error),
            14 => Ok(Self::Abort),
            15 => Ok(Self::AbortAck),
            _ => Err(RelayError::contract("frame_kind_invalid")),
        }
    }
}

#[derive(Debug)]
struct Frame {
    kind: FrameKind,
    sequence: u64,
    identity: RelayIdentity,
    metadata: Map<String, Value>,
    payload: Vec<u8>,
}

impl Frame {
    fn encode(
        kind: FrameKind,
        sequence: u64,
        identity: &RelayIdentity,
        mut metadata: Map<String, Value>,
        payload: &[u8],
    ) -> Result<Vec<u8>, RelayError> {
        if sequence == 0 {
            return Err(RelayError::contract("sequence_invalid"));
        }
        if matches!(kind, FrameKind::Stdin | FrameKind::Stdout) && payload.len() > MAX_STREAM_BYTES
        {
            return Err(RelayError::contract("stream_payload_too_large"));
        }
        identity.insert_into(&mut metadata);
        let metadata = serde_json::to_vec(&metadata)
            .map_err(|_| RelayError::contract("metadata_json_invalid"))?;
        if metadata.len() > MAX_METADATA_BYTES {
            return Err(RelayError::contract("metadata_too_large"));
        }
        let total_bytes = PREFIX_BYTES
            .checked_add(metadata.len())
            .and_then(|value| value.checked_add(payload.len()))
            .ok_or_else(|| RelayError::contract("frame_too_large"))?;
        if total_bytes > MAX_FRAME_BYTES {
            return Err(RelayError::contract("frame_too_large"));
        }
        let body_bytes =
            u32::try_from(total_bytes - 8).map_err(|_| RelayError::contract("frame_too_large"))?;
        let metadata_bytes = u16::try_from(metadata.len())
            .map_err(|_| RelayError::contract("metadata_too_large"))?;
        let mut encoded = Vec::with_capacity(total_bytes);
        encoded.extend_from_slice(MAGIC);
        encoded.extend_from_slice(&body_bytes.to_be_bytes());
        encoded.push(kind as u8);
        encoded.push(0);
        encoded.extend_from_slice(&metadata_bytes.to_be_bytes());
        encoded.extend_from_slice(&sequence.to_be_bytes());
        encoded.extend_from_slice(&metadata);
        encoded.extend_from_slice(payload);
        Ok(encoded)
    }
}

enum ReadFrame {
    Frame(Frame),
    Closed,
}

fn read_frame(stream: &mut UnixStream) -> Result<ReadFrame, RelayError> {
    let mut prefix = [0_u8; PREFIX_BYTES];
    let read = stream.read(&mut prefix[..1])?;
    if read == 0 {
        return Ok(ReadFrame::Closed);
    }
    stream
        .read_exact(&mut prefix[1..])
        .map_err(|_| RelayError::contract("truncated_frame"))?;
    if &prefix[..4] != MAGIC {
        return Err(RelayError::contract("frame_magic_invalid"));
    }
    let body_bytes = u32::from_be_bytes(prefix[4..8].try_into().unwrap()) as usize;
    let total_bytes = body_bytes
        .checked_add(8)
        .ok_or_else(|| RelayError::contract("frame_length_invalid"))?;
    if !(PREFIX_BYTES..=MAX_FRAME_BYTES).contains(&total_bytes) {
        return Err(RelayError::contract("frame_length_invalid"));
    }
    let kind = FrameKind::try_from(prefix[8])?;
    if prefix[9] != 0 {
        return Err(RelayError::contract("frame_flags_invalid"));
    }
    let metadata_bytes = u16::from_be_bytes(prefix[10..12].try_into().unwrap()) as usize;
    if metadata_bytes > MAX_METADATA_BYTES || PREFIX_BYTES + metadata_bytes > total_bytes {
        return Err(RelayError::contract("metadata_length_invalid"));
    }
    let sequence = u64::from_be_bytes(prefix[12..20].try_into().unwrap());
    if sequence == 0 || sequence > (1_u64 << 53) - 1 {
        return Err(RelayError::contract("sequence_invalid"));
    }
    let remainder_bytes = total_bytes - PREFIX_BYTES;
    let mut remainder = vec![0_u8; remainder_bytes];
    stream
        .read_exact(&mut remainder)
        .map_err(|_| RelayError::contract("truncated_frame"))?;
    let metadata_value = serde_json::from_slice::<Value>(&remainder[..metadata_bytes])
        .map_err(|_| RelayError::contract("metadata_json_invalid"))?;
    let metadata = metadata_value
        .as_object()
        .cloned()
        .ok_or_else(|| RelayError::contract("metadata_json_invalid"))?;
    let identity = RelayIdentity::from_metadata(&metadata)?;
    let payload = remainder[metadata_bytes..].to_vec();
    if matches!(kind, FrameKind::Stdin | FrameKind::Stdout) && payload.len() > MAX_STREAM_BYTES {
        return Err(RelayError::contract("stream_payload_too_large"));
    }
    Ok(ReadFrame::Frame(Frame {
        kind,
        sequence,
        identity,
        metadata,
        payload,
    }))
}

fn write_frame(
    stream: &mut UnixStream,
    kind: FrameKind,
    sequence: u64,
    identity: &RelayIdentity,
    metadata: Map<String, Value>,
    payload: &[u8],
) -> Result<(), RelayError> {
    stream.write_all(&Frame::encode(kind, sequence, identity, metadata, payload)?)?;
    Ok(())
}

#[derive(Debug)]
struct RelayOptions {
    endpoint: PathBuf,
    capability_file: PathBuf,
    identity: RelayIdentity,
}

impl RelayOptions {
    fn parse(arguments: impl Iterator<Item = OsString>) -> Result<Self, RelayError> {
        let mut endpoint = None;
        let mut capability_file = None;
        let mut runtime_generation = None;
        let mut query_epoch = None;
        let mut relay_id = None;
        let mut arguments = arguments;
        while let Some(argument) = arguments.next() {
            let value = arguments
                .next()
                .ok_or_else(|| RelayError::contract("arguments_invalid"))?;
            match argument.to_str() {
                Some("--endpoint") if endpoint.is_none() => endpoint = Some(PathBuf::from(value)),
                Some("--capability-file") if capability_file.is_none() => {
                    capability_file = Some(PathBuf::from(value))
                }
                Some("--runtime-generation") if runtime_generation.is_none() => {
                    runtime_generation = value.into_string().ok()
                }
                Some("--query-epoch") if query_epoch.is_none() => {
                    query_epoch = value.into_string().ok()
                }
                Some("--relay-id") if relay_id.is_none() => relay_id = value.into_string().ok(),
                _ => return Err(RelayError::contract("arguments_invalid")),
            }
        }
        let identity = RelayIdentity::new(
            runtime_generation.ok_or_else(|| RelayError::contract("arguments_invalid"))?,
            query_epoch.ok_or_else(|| RelayError::contract("arguments_invalid"))?,
            relay_id.ok_or_else(|| RelayError::contract("arguments_invalid"))?,
        )?;
        Ok(Self {
            endpoint: endpoint.ok_or_else(|| RelayError::contract("arguments_invalid"))?,
            capability_file: capability_file
                .ok_or_else(|| RelayError::contract("arguments_invalid"))?,
            identity,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExecutableIdentity {
    changed_nanoseconds: String,
    changed_seconds: String,
    device: String,
    inode: String,
    modified_nanoseconds: String,
    modified_seconds: String,
    sha256: String,
    size: String,
}

impl ExecutableIdentity {
    fn decimal(value: &str) -> Result<u64, RelayError> {
        if value.is_empty()
            || value.len() > 20
            || value.len() > 1 && value.starts_with('0')
            || !value.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(RelayError::contract("launch_command_identity_invalid"));
        }
        value
            .parse()
            .map_err(|_| RelayError::contract("launch_command_identity_invalid"))
    }

    fn validate(&self, path: &Path) -> Result<(), RelayError> {
        if self.sha256.len() != 71
            || !self.sha256.starts_with("sha256:")
            || !self.sha256[7..]
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(RelayError::contract("launch_command_identity_invalid"));
        }
        let metadata = fs::symlink_metadata(path)
            .map_err(|_| RelayError::contract("launch_command_invalid"))?;
        let changed_seconds = u64::try_from(metadata.ctime())
            .map_err(|_| RelayError::contract("launch_command_identity_invalid"))?;
        let changed_nanoseconds = u64::try_from(metadata.ctime_nsec())
            .map_err(|_| RelayError::contract("launch_command_identity_invalid"))?;
        let modified_seconds = u64::try_from(metadata.mtime())
            .map_err(|_| RelayError::contract("launch_command_identity_invalid"))?;
        let modified_nanoseconds = u64::try_from(metadata.mtime_nsec())
            .map_err(|_| RelayError::contract("launch_command_identity_invalid"))?;
        // SAFETY: geteuid is a side-effect-free query of the current process identity.
        let effective_user_id = unsafe { libc::geteuid() };
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.permissions().mode() & 0o111 == 0
            || metadata.permissions().mode() & 0o022 != 0
            || metadata.uid() != 0 && metadata.uid() != effective_user_id
            || metadata.nlink() != 1
            || changed_seconds != Self::decimal(&self.changed_seconds)?
            || changed_nanoseconds != Self::decimal(&self.changed_nanoseconds)?
            || metadata.dev() != Self::decimal(&self.device)?
            || metadata.ino() != Self::decimal(&self.inode)?
            || metadata.len() != Self::decimal(&self.size)?
            || modified_seconds != Self::decimal(&self.modified_seconds)?
            || modified_nanoseconds != Self::decimal(&self.modified_nanoseconds)?
        {
            return Err(RelayError::contract("launch_command_replaced"));
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LaunchSpecification {
    command: PathBuf,
    command_identity: ExecutableIdentity,
    args: Vec<String>,
    cwd: PathBuf,
    env: BTreeMap<String, String>,
}

impl LaunchSpecification {
    fn parse(payload: &[u8]) -> Result<Self, RelayError> {
        let mut specification: Self =
            serde_json::from_slice(payload).map_err(|_| RelayError::contract("launch_invalid"))?;
        if specification.args.len() > 4096 || specification.env.len() > 4096 {
            return Err(RelayError::contract("launch_too_large"));
        }
        if !specification.command.is_absolute() || !specification.cwd.is_absolute() {
            return Err(RelayError::contract("launch_path_not_absolute"));
        }
        specification
            .command_identity
            .validate(&specification.command)?;
        specification.command = specification
            .command
            .canonicalize()
            .map_err(|_| RelayError::contract("launch_command_invalid"))?;
        specification.cwd = specification
            .cwd
            .canonicalize()
            .map_err(|_| RelayError::contract("launch_cwd_invalid"))?;
        if !specification.command.is_file() || !specification.cwd.is_dir() {
            return Err(RelayError::contract("launch_path_invalid"));
        }
        if specification
            .args
            .iter()
            .any(|value| value.as_bytes().contains(&0))
            || specification.env.iter().any(|(key, value)| {
                key.is_empty()
                    || key.contains('=')
                    || key.as_bytes().contains(&0)
                    || value.as_bytes().contains(&0)
            })
        {
            return Err(RelayError::contract("launch_value_invalid"));
        }
        Ok(specification)
    }

    fn spawn(self) -> Result<Child, RelayError> {
        self.command_identity.validate(&self.command)?;
        Command::new(self.command)
            .args(self.args)
            .current_dir(self.cwd)
            .env_clear()
            .envs(self.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| RelayError::contract("child_spawn_failed"))
    }
}

enum HostEvent {
    Frame(Frame),
    Closed,
    Failed(RelayError),
}

enum StdoutEvent {
    Chunk {
        bytes: Vec<u8>,
        release: SyncSender<()>,
    },
    Eof,
    Failed,
}

struct StderrTail {
    bytes: Vec<u8>,
    truncated: bool,
}

struct ChildGuard {
    child: Child,
    process_id: u32,
}

impl ChildGuard {
    fn new(child: Child) -> Self {
        let process_id = child.id();
        Self { child, process_id }
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        terminate_child(&mut self.child, self.process_id);
    }
}

fn read_capability(path: &Path) -> Result<String, RelayError> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| RelayError::contract("capability_file_invalid"))?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.mode() & 0o077 != 0
        // SAFETY: geteuid is a side-effect-free query of the current process identity.
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.len() > 512
    {
        return Err(RelayError::contract("capability_file_unsafe"));
    }
    let capability =
        fs::read_to_string(path).map_err(|_| RelayError::contract("capability_file_invalid"))?;
    if capability.len() < 16 || capability.len() > 256 || capability.chars().any(char::is_control) {
        return Err(RelayError::contract("capability_invalid"));
    }
    Ok(capability)
}

fn consume_capability(path: &Path) -> Result<(), RelayError> {
    fs::remove_file(path).map_err(|_| RelayError::contract("capability_consume_failed"))
}

fn bind_endpoint(path: &Path) -> Result<UnixListener, RelayError> {
    if !path.is_absolute() || fs::symlink_metadata(path).is_ok() {
        return Err(RelayError::contract("endpoint_invalid"));
    }
    let parent = path
        .parent()
        .ok_or_else(|| RelayError::contract("endpoint_parent_invalid"))?;
    let metadata = fs::symlink_metadata(parent)
        .map_err(|_| RelayError::contract("endpoint_parent_invalid"))?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.mode() & 0o077 != 0
        // SAFETY: geteuid is a side-effect-free query of the current process identity.
        || metadata.uid() != unsafe { libc::geteuid() }
    {
        return Err(RelayError::contract("endpoint_parent_unsafe"));
    }
    let listener =
        UnixListener::bind(path).map_err(|_| RelayError::contract("endpoint_bind_failed"))?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|_| RelayError::contract("endpoint_permissions_failed"))?;
    Ok(listener)
}

fn spawn_host_reader(mut stream: UnixStream) -> Receiver<HostEvent> {
    let (sender, receiver) = sync_channel(HOST_EVENT_CAPACITY);
    thread::spawn(move || {
        loop {
            let event = match read_frame(&mut stream) {
                Ok(ReadFrame::Frame(frame)) => HostEvent::Frame(frame),
                Ok(ReadFrame::Closed) => HostEvent::Closed,
                Err(error) => HostEvent::Failed(error),
            };
            let terminal = !matches!(event, HostEvent::Frame(_));
            if sender.send(event).is_err() || terminal {
                break;
            }
        }
    });
    receiver
}

fn spawn_stdout_reader(mut stdout: impl Read + Send + 'static) -> Receiver<StdoutEvent> {
    let (sender, receiver) = sync_channel(1);
    thread::spawn(move || {
        let mut buffer = vec![0_u8; MAX_STREAM_BYTES];
        loop {
            match stdout.read(&mut buffer) {
                Ok(0) => {
                    let _ = sender.send(StdoutEvent::Eof);
                    break;
                }
                Ok(length) => {
                    let (release, released) = sync_channel(0);
                    if sender
                        .send(StdoutEvent::Chunk {
                            bytes: buffer[..length].to_vec(),
                            release,
                        })
                        .is_err()
                        || released.recv().is_err()
                    {
                        break;
                    }
                }
                Err(_) => {
                    let _ = sender.send(StdoutEvent::Failed);
                    break;
                }
            }
        }
    });
    receiver
}

fn spawn_stderr_reader(mut stderr: impl Read + Send + 'static) -> Receiver<StderrTail> {
    let (sender, receiver) = sync_channel(1);
    thread::spawn(move || {
        let mut tail = Vec::with_capacity(MAX_STDERR_BYTES);
        let mut truncated = false;
        let mut buffer = [0_u8; 4096];
        loop {
            let length = match stderr.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(length) => length,
            };
            append_stderr(&mut tail, &buffer[..length], &mut truncated);
        }
        let _ = sender.send(StderrTail {
            bytes: tail,
            truncated,
        });
    });
    receiver
}

fn append_stderr(tail: &mut Vec<u8>, bytes: &[u8], truncated: &mut bool) {
    if bytes.len() >= MAX_STDERR_BYTES {
        tail.clear();
        tail.extend_from_slice(&bytes[bytes.len() - MAX_STDERR_BYTES..]);
        *truncated = true;
        return;
    }
    let overflow = tail
        .len()
        .saturating_add(bytes.len())
        .saturating_sub(MAX_STDERR_BYTES);
    if overflow > 0 {
        tail.drain(..overflow);
        *truncated = true;
    }
    tail.extend_from_slice(bytes);
}

fn metadata_string<'a>(metadata: &'a Map<String, Value>, key: &str) -> Result<&'a str, RelayError> {
    metadata
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| RelayError::contract(format!("metadata_{key}_invalid")))
}

fn metadata_sequence(metadata: &Map<String, Value>, key: &str) -> Result<u64, RelayError> {
    metadata
        .get(key)
        .and_then(Value::as_u64)
        .filter(|value| *value > 0 && *value < (1_u64 << 53))
        .ok_or_else(|| RelayError::contract(format!("metadata_{key}_invalid")))
}

fn metadata_map(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

fn next_sequence(sequence: &mut u64) -> Result<u64, RelayError> {
    *sequence = sequence
        .checked_add(1)
        .filter(|value| *value < (1_u64 << 53))
        .ok_or_else(|| RelayError::contract("sequence_exhausted"))?;
    Ok(*sequence)
}

fn unix_signal(name: &str) -> Option<libc::c_int> {
    match name {
        "SIGHUP" => Some(libc::SIGHUP),
        "SIGINT" => Some(libc::SIGINT),
        "SIGKILL" => Some(libc::SIGKILL),
        "SIGTERM" => Some(libc::SIGTERM),
        _ => None,
    }
}

fn signal_name(signal: Option<i32>) -> Result<Option<&'static str>, RelayError> {
    match signal {
        Some(value) if value == libc::SIGABRT => Ok(Some("SIGABRT")),
        Some(value) if value == libc::SIGALRM => Ok(Some("SIGALRM")),
        Some(value) if value == libc::SIGBUS => Ok(Some("SIGBUS")),
        Some(value) if value == libc::SIGCHLD => Ok(Some("SIGCHLD")),
        Some(value) if value == libc::SIGCONT => Ok(Some("SIGCONT")),
        Some(value) if value == libc::SIGFPE => Ok(Some("SIGFPE")),
        Some(value) if value == libc::SIGHUP => Ok(Some("SIGHUP")),
        Some(value) if value == libc::SIGILL => Ok(Some("SIGILL")),
        Some(value) if value == libc::SIGINT => Ok(Some("SIGINT")),
        Some(value) if value == libc::SIGIO => Ok(Some("SIGIO")),
        Some(value) if value == libc::SIGKILL => Ok(Some("SIGKILL")),
        Some(value) if value == libc::SIGPIPE => Ok(Some("SIGPIPE")),
        Some(value) if value == libc::SIGPROF => Ok(Some("SIGPROF")),
        Some(value) if value == libc::SIGQUIT => Ok(Some("SIGQUIT")),
        Some(value) if value == libc::SIGSEGV => Ok(Some("SIGSEGV")),
        Some(value) if value == libc::SIGSTOP => Ok(Some("SIGSTOP")),
        Some(value) if value == libc::SIGSYS => Ok(Some("SIGSYS")),
        Some(value) if value == libc::SIGTERM => Ok(Some("SIGTERM")),
        Some(value) if value == libc::SIGTRAP => Ok(Some("SIGTRAP")),
        Some(value) if value == libc::SIGTSTP => Ok(Some("SIGTSTP")),
        Some(value) if value == libc::SIGTTIN => Ok(Some("SIGTTIN")),
        Some(value) if value == libc::SIGTTOU => Ok(Some("SIGTTOU")),
        Some(value) if value == libc::SIGURG => Ok(Some("SIGURG")),
        Some(value) if value == libc::SIGUSR1 => Ok(Some("SIGUSR1")),
        Some(value) if value == libc::SIGUSR2 => Ok(Some("SIGUSR2")),
        Some(value) if value == libc::SIGVTALRM => Ok(Some("SIGVTALRM")),
        Some(value) if value == libc::SIGWINCH => Ok(Some("SIGWINCH")),
        Some(value) if value == libc::SIGXCPU => Ok(Some("SIGXCPU")),
        Some(value) if value == libc::SIGXFSZ => Ok(Some("SIGXFSZ")),
        Some(_) => Err(RelayError::contract("child_signal_unknown")),
        None => Ok(None),
    }
}

fn send_signal(process_id: u32, signal: libc::c_int) -> Result<(), RelayError> {
    // SAFETY: process_id is the exact direct child retained by this relay and
    // signal is selected from the bounded v1 signal vocabulary.
    let result = unsafe { libc::kill(process_id as libc::pid_t, signal) };
    if result == 0 {
        Ok(())
    } else {
        Err(RelayError::contract("child_signal_failed"))
    }
}

fn terminate_child(child: &mut Child, process_id: u32) {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return;
    }
    let _ = send_signal(process_id, libc::SIGTERM);
    let deadline = Instant::now() + CHILD_EXIT_GRACE;
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        thread::sleep(POLL_INTERVAL);
    }
    let _ = send_signal(process_id, libc::SIGKILL);
    let _ = child.wait();
}

fn send_error(stream: &mut UnixStream, sequence: &mut u64, identity: &RelayIdentity, reason: &str) {
    let Ok(sequence) = next_sequence(sequence) else {
        return;
    };
    let _ = write_frame(
        stream,
        FrameKind::Error,
        sequence,
        identity,
        metadata_map(json!({ "reason": reason })),
        &[],
    );
}

struct RelaySessionState {
    expected_host_sequence: u64,
    relay_sequence: u64,
    child_stdin: Option<ChildStdin>,
    pending_stdout: Option<(u64, SyncSender<()>)>,
    child_exited: bool,
}

fn process_host_frame(
    frame: Frame,
    state: &mut RelaySessionState,
    identity: &RelayIdentity,
    writer: &mut UnixStream,
    process_id: u32,
) -> Result<(), RelayError> {
    if frame.identity != *identity
        || frame.sequence != state.expected_host_sequence.saturating_add(1)
    {
        return Err(RelayError::contract("stale_or_gapped_host_frame"));
    }
    state.expected_host_sequence = frame.sequence;
    match frame.kind {
        FrameKind::Stdin => {
            let child_stdin = state
                .child_stdin
                .as_mut()
                .ok_or_else(|| RelayError::contract("stdin_after_eof"))?;
            child_stdin
                .write_all(&frame.payload)
                .map_err(|_| RelayError::contract("child_stdin_failed"))?;
            write_frame(
                writer,
                FrameKind::StdinAck,
                next_sequence(&mut state.relay_sequence)?,
                identity,
                metadata_map(json!({ "ackSequence": frame.sequence })),
                &[],
            )?;
        }
        FrameKind::StdinEof => {
            if !frame.payload.is_empty() || state.child_stdin.take().is_none() {
                return Err(RelayError::contract("stdin_eof_invalid"));
            }
            write_frame(
                writer,
                FrameKind::StdinEofAck,
                next_sequence(&mut state.relay_sequence)?,
                identity,
                metadata_map(json!({ "ackSequence": frame.sequence })),
                &[],
            )?;
        }
        FrameKind::StdoutAck => {
            let ack_sequence = metadata_sequence(&frame.metadata, "ackSequence")?;
            let (expected, release) = state
                .pending_stdout
                .take()
                .ok_or_else(|| RelayError::contract("stdout_ack_without_chunk"))?;
            if ack_sequence != expected {
                return Err(RelayError::contract("stdout_ack_invalid"));
            }
            release
                .send(())
                .map_err(|_| RelayError::contract("stdout_release_failed"))?;
        }
        FrameKind::Signal => {
            if !frame.payload.is_empty() {
                return Err(RelayError::contract("signal_payload_invalid"));
            }
            let signal_name = metadata_string(&frame.metadata, "signal")?;
            let signal =
                unix_signal(signal_name).ok_or_else(|| RelayError::contract("signal_invalid"))?;
            if !state.child_exited {
                send_signal(process_id, signal)?;
            }
            write_frame(
                writer,
                FrameKind::SignalAck,
                next_sequence(&mut state.relay_sequence)?,
                identity,
                metadata_map(json!({ "ackSequence": frame.sequence })),
                &[],
            )?;
        }
        FrameKind::Abort => {
            if !frame.payload.is_empty() {
                return Err(RelayError::contract("abort_payload_invalid"));
            }
            if !state.child_exited {
                send_signal(process_id, libc::SIGTERM)?;
            }
            write_frame(
                writer,
                FrameKind::AbortAck,
                next_sequence(&mut state.relay_sequence)?,
                identity,
                metadata_map(json!({ "ackSequence": frame.sequence })),
                &[],
            )?;
        }
        _ => return Err(RelayError::contract("unexpected_host_frame")),
    }
    Ok(())
}

fn run_session(
    mut stream: UnixStream,
    identity: &RelayIdentity,
    capability: &str,
    capability_file: &Path,
) -> Result<(), RelayError> {
    let hello = match read_frame(&mut stream)? {
        ReadFrame::Frame(frame) => frame,
        ReadFrame::Closed => return Err(RelayError::contract("hello_missing")),
    };
    if hello.kind != FrameKind::Hello
        || hello.sequence != 1
        || hello.identity != *identity
        || metadata_string(&hello.metadata, "launchCapability")? != capability
    {
        let mut sequence = 0;
        send_error(&mut stream, &mut sequence, identity, "hello_rejected");
        return Err(RelayError::contract("hello_invalid"));
    }
    consume_capability(capability_file)?;
    let launch = match LaunchSpecification::parse(&hello.payload) {
        Ok(launch) => launch,
        Err(error) => {
            let mut sequence = 0;
            send_error(&mut stream, &mut sequence, identity, "launch_rejected");
            return Err(error);
        }
    };
    let mut child = ChildGuard::new(launch.spawn()?);
    let process_id = child.process_id;
    let child_stdin = child.child.stdin.take();
    let stdout = child
        .child
        .stdout
        .take()
        .ok_or_else(|| RelayError::contract("child_stdout_missing"))?;
    let stderr = child
        .child
        .stderr
        .take()
        .ok_or_else(|| RelayError::contract("child_stderr_missing"))?;
    let stdout_events = spawn_stdout_reader(stdout);
    let stderr_events = spawn_stderr_reader(stderr);
    let reader = stream.try_clone()?;
    let host_events = spawn_host_reader(reader);
    let mut state = RelaySessionState {
        expected_host_sequence: hello.sequence,
        relay_sequence: 0,
        child_stdin,
        pending_stdout: None,
        child_exited: false,
    };
    write_frame(
        &mut stream,
        FrameKind::Ready,
        next_sequence(&mut state.relay_sequence)?,
        identity,
        metadata_map(json!({ "helloSequence": hello.sequence, "pid": process_id })),
        &[],
    )?;
    let mut stdout_eof = false;
    let mut stderr_tail = None;
    let mut exit_status: Option<ExitStatus> = None;

    loop {
        if exit_status.is_none() {
            exit_status = child
                .child
                .try_wait()
                .map_err(|_| RelayError::contract("child_wait_failed"))?;
        }
        state.child_exited = exit_status.is_some();
        if state.pending_stdout.is_none() && !stdout_eof {
            match stdout_events.try_recv() {
                Ok(StdoutEvent::Chunk { bytes, release }) => {
                    let sequence = next_sequence(&mut state.relay_sequence)?;
                    write_frame(
                        &mut stream,
                        FrameKind::Stdout,
                        sequence,
                        identity,
                        Map::new(),
                        &bytes,
                    )?;
                    state.pending_stdout = Some((sequence, release));
                }
                Ok(StdoutEvent::Eof) => {
                    write_frame(
                        &mut stream,
                        FrameKind::StdoutEof,
                        next_sequence(&mut state.relay_sequence)?,
                        identity,
                        Map::new(),
                        &[],
                    )?;
                    stdout_eof = true;
                }
                Ok(StdoutEvent::Failed) => {
                    terminate_child(&mut child.child, process_id);
                    return Err(RelayError::contract("child_stdout_failed"));
                }
                Err(TryRecvError::Empty) => {}
                Err(TryRecvError::Disconnected) => {
                    return Err(RelayError::contract("stdout_reader_lost"));
                }
            }
        }
        if stderr_tail.is_none() {
            match stderr_events.try_recv() {
                Ok(tail) => stderr_tail = Some(tail),
                Err(TryRecvError::Empty) => {}
                Err(TryRecvError::Disconnected) => {
                    return Err(RelayError::contract("stderr_reader_lost"));
                }
            }
        }
        if let (Some(status), true, Some(tail), None) = (
            exit_status,
            stdout_eof,
            stderr_tail.as_ref(),
            state.pending_stdout.as_ref(),
        ) {
            let signal = signal_name(status.signal())?;
            write_frame(
                &mut stream,
                FrameKind::Exit,
                next_sequence(&mut state.relay_sequence)?,
                identity,
                metadata_map(json!({
                    "code": status.code(),
                    "signal": signal,
                    "stderrTruncated": tail.truncated,
                })),
                &tail.bytes,
            )?;
            return Ok(());
        }

        match host_events.recv_timeout(POLL_INTERVAL) {
            Ok(HostEvent::Frame(frame)) => {
                if let Err(error) =
                    process_host_frame(frame, &mut state, identity, &mut stream, process_id)
                {
                    send_error(
                        &mut stream,
                        &mut state.relay_sequence,
                        identity,
                        "protocol_violation",
                    );
                    terminate_child(&mut child.child, process_id);
                    return Err(error);
                }
            }
            Ok(HostEvent::Closed) => {
                terminate_child(&mut child.child, process_id);
                return Err(RelayError::contract("host_disconnected"));
            }
            Ok(HostEvent::Failed(error)) => {
                terminate_child(&mut child.child, process_id);
                return Err(error);
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                terminate_child(&mut child.child, process_id);
                return Err(RelayError::contract("host_reader_lost"));
            }
        }
    }
}

pub fn run_from_arguments(arguments: impl Iterator<Item = OsString>) -> Result<(), RelayError> {
    let options = RelayOptions::parse(arguments)?;
    let capability = read_capability(&options.capability_file)?;
    let listener = bind_endpoint(&options.endpoint)?;
    let result = listener
        .accept()
        .map_err(|_| RelayError::contract("endpoint_accept_failed"));
    let _ = fs::remove_file(&options.endpoint);
    let (stream, _) = result?;
    run_session(
        stream,
        &options.identity,
        &capability,
        &options.capability_file,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity() -> RelayIdentity {
        RelayIdentity::new("runtime-1".into(), "query-1".into(), "relay-1".into()).unwrap()
    }

    #[test]
    fn frame_round_trip_preserves_binary_payload_and_authoritative_identity() {
        let mut metadata = metadata_map(json!({
            "runtimeGeneration": "stale",
            "ackSequence": 7,
        }));
        let bytes = Frame::encode(
            FrameKind::Stdout,
            9,
            &identity(),
            std::mem::take(&mut metadata),
            &[0, 1, 2, 255],
        )
        .unwrap();
        let root = tempfile::tempdir().unwrap();
        let socket = root.path().join("pair.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let writer = UnixStream::connect(&socket).unwrap();
        let (mut reader, _) = listener.accept().unwrap();
        (&writer).write_all(&bytes).unwrap();
        let ReadFrame::Frame(frame) = read_frame(&mut reader).unwrap() else {
            panic!("frame unexpectedly closed");
        };
        assert_eq!(frame.kind, FrameKind::Stdout);
        assert_eq!(frame.sequence, 9);
        assert_eq!(frame.identity, identity());
        assert_eq!(frame.payload, [0, 1, 2, 255]);
        assert_eq!(
            metadata_sequence(&frame.metadata, "ackSequence").unwrap(),
            7
        );
    }

    #[test]
    fn stderr_tail_is_bounded_to_the_latest_bytes() {
        let mut tail = Vec::new();
        let mut truncated = false;
        append_stderr(&mut tail, &[b'a'; MAX_STDERR_BYTES], &mut truncated);
        append_stderr(&mut tail, &[b'b'; 16], &mut truncated);
        assert_eq!(tail.len(), MAX_STDERR_BYTES);
        assert!(truncated);
        assert!(
            tail[..MAX_STDERR_BYTES - 16]
                .iter()
                .all(|byte| *byte == b'a')
        );
        assert!(
            tail[MAX_STDERR_BYTES - 16..]
                .iter()
                .all(|byte| *byte == b'b')
        );
    }

    #[test]
    fn post_exit_signal_is_acknowledged_without_retargeting_a_pid() {
        let (mut reader, mut writer) = UnixStream::pair().unwrap();
        let identity = identity();
        let mut state = RelaySessionState {
            expected_host_sequence: 1,
            relay_sequence: 1,
            child_stdin: None,
            pending_stdout: None,
            child_exited: true,
        };
        let frame = Frame {
            kind: FrameKind::Signal,
            sequence: 2,
            identity: identity.clone(),
            metadata: metadata_map(json!({ "signal": "SIGTERM" })),
            payload: Vec::new(),
        };

        process_host_frame(frame, &mut state, &identity, &mut writer, 1_000_000_000).unwrap();

        let ReadFrame::Frame(ack) = read_frame(&mut reader).unwrap() else {
            panic!("signal acknowledgement unexpectedly closed");
        };
        assert_eq!(ack.kind, FrameKind::SignalAck);
        assert_eq!(metadata_sequence(&ack.metadata, "ackSequence").unwrap(), 2);
    }
}
