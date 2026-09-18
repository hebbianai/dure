//! Bounded remote session discovery over the same no-PTY gateway transport.
//!
//! A remote attach needs the complete seven-field session fence. Guessing from
//! a cached pane binding after the remote Host restarts would either attach the
//! wrong generation or loop forever on a stale identity, so discovery is a
//! first-class request to `hmux mobile-gateway`.

use crate::{
    ChannelCompletion, SshAuthentication, SshExecConfig, SshExecDialer, SshTransportError,
};
use hmux_client::{SessionRetirementPolicy, SessionRetirementReceipt};
use hmux_session_protocol::transport::FrameWriter;
use hmux_session_protocol::{
    ErrorCode, FrameBody, FrameLimits, InputReceipt, InputReceiptState, PROTOCOL_V1, SessionFence,
    WireFrame,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fmt;
use std::time::{Duration, Instant};

mod response;
pub mod session_resolution;
pub(crate) use response::{finish_answer, read_answer};
use response::{read_document, response_io};

const GATEWAY_REQUEST_VERSION_V1: u16 = 1;
const GATEWAY_REQUEST_VERSION_RETIREMENT_POLICY: u16 = 2;
const GATEWAY_REQUEST_VERSION_ABANDON_UNPRESENTED_CREATION: u16 = 3;
const GATEWAY_REQUEST_VERSION_SESSION_FACTS: u16 = 4;
const GATEWAY_REQUEST_VERSION_EXACT_INPUT: u16 = 5;
const GATEWAY_REQUEST_VERSION_GATEWAY_BUILD: u16 = 6;
const GATEWAY_REQUEST_VERSION_WORKING_DIRECTORY: u16 = 7;
/// A read of what version control says about one session's directory. Three
/// identifiers, no `want` — the shape every box in the field already serves.
const GATEWAY_REQUEST_VERSION_SOURCE_CONTROL: u16 = 8;
/// The same read, naming which of the three answers to compute. A box that
/// refuses this one is a box whose `hmux` predates the commits and review
/// readers; it still answers the changes tab at version 8.
const GATEWAY_REQUEST_VERSION_SOURCE_CONTROL_WANT: u16 = 9;
/// One file's patch, chosen from the list the box itself produced.
///
/// Its own request rather than a field on the status document: that document's
/// shape is the promise that the read names nothing, and the changes tab still
/// depends on that promise being kept.
const GATEWAY_REQUEST_VERSION_SOURCE_CONTROL_DIFF: u16 = 10;
/// The answer document version this build understands. Compared strictly, so
/// it is never raised to add a field.
const SUPPORTED_SOURCE_CONTROL_VERSION: u16 = 1;
const SUPPORTED_SOURCE_CONTROL_DIFF_VERSION: u16 = 1;
const GATEWAY_CATALOG_VERSION_V1: u16 = 1;
const GATEWAY_CATALOG_VERSION_RETIREMENT_POLICY: u16 = 2;
const GATEWAY_CATALOG_VERSION_SESSION_FACTS: u16 = 3;
const GATEWAY_CATALOG_VERSION_GATEWAY_BUILD: u16 = 4;
const MAX_CATALOG_SESSIONS: usize = 1_024;
pub const MAX_REMOTE_SESSION_INPUT_BYTES: usize = 48 * 1024;
const LENGTH_PREFIX_BYTES: usize = 4;

pub use hmux_session_protocol::discovery::SessionClass as RemoteSessionClass;
pub use hmux_session_protocol::{
    ProtocolVersion as RemoteProtocolVersion, VersionRange as RemoteVersionRange,
};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteSessionLifecycle {
    Ready,
    Exited,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteHostLiveness {
    Live,
    Absent,
    Unknown,
}

/// Non-secret, host-owned identity returned by the remote gateway allow-list.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RemoteCatalogSession {
    pub session_id: String,
    pub session_name: Option<String>,
    pub workspace_id: String,
    pub session_class: RemoteSessionClass,
    pub lifecycle: RemoteSessionLifecycle,
    pub provider_id: String,
    pub runner_principal: String,
    pub runner_instance: String,
    pub channel_epoch: String,
    pub host_instance_id: String,
    pub terminal_epoch: String,
    pub supported_protocol: RemoteVersionRange,
    pub capabilities: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retirement_policy: Option<SessionRetirementPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_program: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_liveness: Option<RemoteHostLiveness>,
    /// Build selected by the gateway that returned this catalog. Catalog v4
    /// supplies it; v3 compatibility catalogs and v1 create receipts omit it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gateway_build_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RemoteCommandIntercept {
    pub command: String,
    pub provider_id: String,
}

#[derive(Clone, Deserialize, Eq, PartialEq, Serialize)]
pub struct RemoteStandaloneCreateRequest {
    pub request_id: String,
    pub target_session_id: String,
    pub launch_owner_proof: String,
    pub session_name: String,
    pub bridge_nonce: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub initial_rows: u16,
    pub initial_columns: u16,
    pub command_intercepts: Vec<RemoteCommandIntercept>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retirement_policy: Option<SessionRetirementPolicy>,
}

impl fmt::Debug for RemoteStandaloneCreateRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RemoteStandaloneCreateRequest")
            .field("request_id", &self.request_id)
            .field("target_session_id", &self.target_session_id)
            .field("launch_owner_proof", &"<redacted>")
            .field("session_name", &self.session_name)
            .field("bridge_nonce", &self.bridge_nonce)
            .field("cwd", &self.cwd)
            .field("initial_rows", &self.initial_rows)
            .field("initial_columns", &self.initial_columns)
            .field("command_intercepts", &self.command_intercepts)
            .field("retirement_policy", &self.retirement_policy)
            .finish()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RemoteStandaloneCreateReceipt {
    pub request_id: String,
    pub bridge_nonce: String,
    pub session: RemoteCatalogSession,
}

#[derive(Clone, Eq, PartialEq, Serialize)]
pub struct RemoteUnpresentedCreationAbandonRequest {
    pub request_id: String,
    pub session_id: String,
    pub workspace_id: String,
    pub launch_owner_proof: String,
}

#[derive(Clone, Eq, PartialEq, Serialize)]
pub struct RemoteSessionInputRequest {
    pub request_id: String,
    pub expected_fence: SessionFence,
    pub bytes: Vec<u8>,
}

impl fmt::Debug for RemoteSessionInputRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RemoteSessionInputRequest")
            .field("request_id", &self.request_id)
            .field("expected_fence", &self.expected_fence)
            .field("byte_length", &self.bytes.len())
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RemoteSessionInputReceipt {
    pub request_id: String,
    pub session_id: String,
    pub workspace_id: String,
    pub receipt: InputReceipt,
}

impl fmt::Debug for RemoteUnpresentedCreationAbandonRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RemoteUnpresentedCreationAbandonRequest")
            .field("request_id", &self.request_id)
            .field("session_id", &self.session_id)
            .field("workspace_id", &self.workspace_id)
            .field("launch_owner_proof", &"<redacted>")
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RemoteUnpresentedCreationAbandonReceipt {
    pub request_id: String,
    pub session_id: String,
    pub workspace_id: String,
    pub receipt: SessionRetirementReceipt,
}

#[derive(Debug)]
pub enum CatalogError {
    Ssh(SshTransportError),
    Request(String),
    Response(String),
    /// A completed command failed without returning an answer.
    CommandFailed(ChannelCompletion),
    Refused {
        code: ErrorCode,
        message: String,
    },
}

impl CatalogError {
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::Ssh(error) => error.code(),
            Self::Request(_) => "hmux_gateway_catalog_request_failed",
            Self::Response(_) => "hmux_gateway_catalog_response_invalid",
            Self::CommandFailed(_) => "hmux_gateway_command_failed",
            Self::Refused {
                code: ErrorCode::UnsupportedProtocolVersion,
                ..
            } => "hmux_protocol_version_unsupported",
            Self::Refused { .. } => "hmux_gateway_catalog_refused",
        }
    }

    #[must_use]
    pub fn is_unsupported_protocol_version(&self) -> bool {
        matches!(
            self,
            Self::Refused {
                code: hmux_session_protocol::ErrorCode::UnsupportedProtocolVersion,
                ..
            }
        )
    }
}

impl fmt::Display for CatalogError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Ssh(error) => write!(formatter, "{error}"),
            Self::Request(detail) => write!(
                formatter,
                "could not request the remote Hmux catalog: {detail}"
            ),
            Self::Response(detail) => {
                write!(formatter, "the remote Hmux catalog was invalid: {detail}")
            }
            Self::CommandFailed(detail) => {
                write!(
                    formatter,
                    "the remote Hmux gateway did not answer: {detail}"
                )
            }
            Self::Refused { message, .. } => write!(
                formatter,
                "the remote Hmux gateway refused the catalog request: {message}"
            ),
        }
    }
}

impl std::error::Error for CatalogError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Ssh(error) => Some(error),
            _ => None,
        }
    }
}

#[derive(Serialize)]
struct GatewayRequestDocument {
    gateway_request_version: u16,
    request: GatewayRequest,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum GatewayRequest {
    ListSessions,
    CreateStandalone(RemoteStandaloneCreateRequest),
    AbandonUnpresentedCreation(RemoteUnpresentedCreationAbandonRequest),
    WriteSessionInput(RemoteSessionInputRequest),
    SourceControlStatus(SourceControlStatusRequest),
    SourceControlFileDiff(SourceControlFileDiffRequest),
    ResolveSession(session_resolution::SessionResolutionRequest),
}

/// Which session to read, and which of its questions to answer.
///
/// Three identifiers and a closed choice. No path, no revision, no argument:
/// the box resolves the directory from its own Host state, and any of those
/// would turn a directory read into a command channel.
///
/// `want` is skipped when absent rather than written as `null`, because every
/// box shipped before the want existed parses this document with
/// `deny_unknown_fields` — a `want` key of any value is unknown to them.
#[derive(Debug, Serialize)]
pub struct SourceControlStatusRequest {
    pub request_id: String,
    pub session_id: String,
    pub workspace_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub want: Option<SourceControlWant>,
}

/// Which file to read, and optionally inside which commit.
///
/// The one request in this vocabulary that carries a path. What makes that
/// admissible is not a check here — it is that the box lists the repository
/// first and refuses a path its own listing did not produce. This side chooses
/// among what the repository offered; it never names something the repository
/// did not.
#[derive(Debug, Serialize)]
pub struct SourceControlFileDiffRequest {
    pub request_id: String,
    pub session_id: String,
    pub workspace_id: String,
    pub path: String,
    /// A short SHA the commits read handed out. The box proves it is
    /// hexadecimal before it becomes argv.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
}

/// Which tab is asking.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceControlWant {
    /// What is uncommitted. Sent WITHOUT a `want` key, at request version 8, so
    /// a box that predates the newer readers keeps answering the tab it always
    /// answered. There is an older way to ask this one, and it is the only one.
    #[default]
    Changes,
    Commits,
    PullRequest,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CatalogDocument {
    gateway_catalog_version: u16,
    #[serde(default)]
    forced_command_applied: bool,
    #[serde(default)]
    gateway_build_id: Option<String>,
    session: RemoteCatalogSession,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StandaloneCreateDocument {
    gateway_create_version: u16,
    request_id: String,
    bridge_nonce: String,
    session: RemoteCatalogSession,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AbandonUnpresentedCreationDocument {
    gateway_abandon_version: u16,
    request_id: String,
    session_id: String,
    workspace_id: String,
    receipt: SessionRetirementReceipt,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionInputDocument {
    gateway_input_version: u16,
    request_id: String,
    session_id: String,
    workspace_id: String,
    receipt: InputReceipt,
}

/// Lists every session visible through one pinned SSH gateway.
///
/// The timeout includes connection admission, authentication, channel opening
/// and the complete response. Records cannot extend the caller's deadline.
pub fn list_sessions_over_ssh(
    ssh: SshExecConfig,
    timeout: Duration,
) -> Result<Vec<RemoteCatalogSession>, CatalogError> {
    list_sessions_over_ssh_version(
        ssh,
        catalog_deadline(timeout)?,
        GATEWAY_REQUEST_VERSION_RETIREMENT_POLICY,
        GATEWAY_CATALOG_VERSION_RETIREMENT_POLICY,
    )
}

/// Lists sessions together with the remote installation's selected build and
/// per-session liveness facts. Retry the compatibility listing only after a
/// typed unsupported-version refusal, never after auth or trust failures.
pub fn list_sessions_with_facts_over_ssh(
    ssh: SshExecConfig,
    timeout: Duration,
) -> Result<Vec<RemoteCatalogSession>, CatalogError> {
    let deadline = catalog_deadline(timeout)?;
    let session_facts_ssh = ssh_config_for_retry(&ssh);
    match list_sessions_over_ssh_version(
        ssh,
        deadline,
        GATEWAY_REQUEST_VERSION_GATEWAY_BUILD,
        GATEWAY_CATALOG_VERSION_GATEWAY_BUILD,
    ) {
        Err(error) if error.is_unsupported_protocol_version() => list_sessions_over_ssh_version(
            session_facts_ssh,
            deadline,
            GATEWAY_REQUEST_VERSION_SESSION_FACTS,
            GATEWAY_CATALOG_VERSION_SESSION_FACTS,
        ),
        result => result,
    }
}

fn catalog_deadline(timeout: Duration) -> Result<Instant, CatalogError> {
    Instant::now()
        .checked_add(timeout)
        .ok_or_else(|| CatalogError::Request("the catalog timeout overflowed".into()))
}

/// Duplicates connection material only for one typed catalog-version retry.
/// Keeping this private avoids making secret-bearing authentication generally
/// cloneable while preserving the public one-config listing API.
fn ssh_config_for_retry(ssh: &SshExecConfig) -> SshExecConfig {
    let authentication = match &ssh.authentication {
        SshAuthentication::PrivateKey {
            openssh_pem,
            passphrase,
        } => SshAuthentication::PrivateKey {
            openssh_pem: openssh_pem.clone(),
            passphrase: passphrase.clone(),
        },
        SshAuthentication::Agent => SshAuthentication::Agent,
        SshAuthentication::Password(password) => SshAuthentication::Password(password.clone()),
    };
    SshExecConfig {
        endpoint: ssh.endpoint.clone(),
        user: ssh.user.clone(),
        authentication,
        host_key: ssh.host_key.clone(),
        command: ssh.command.clone(),
        connect_timeout: ssh.connect_timeout,
        write_admission_timeout: ssh.write_admission_timeout,
    }
}

fn list_sessions_over_ssh_version(
    ssh: SshExecConfig,
    deadline: Instant,
    gateway_request_version: u16,
    gateway_catalog_version: u16,
) -> Result<Vec<RemoteCatalogSession>, CatalogError> {
    let mut transport =
        SshExecDialer::open_halves_before(ssh, deadline).map_err(CatalogError::Ssh)?;
    let request =
        encode_request_with_listing_version(GatewayRequest::ListSessions, gateway_request_version)?;
    transport
        .writer
        .write_frame_before(&request, Some(deadline))
        .map_err(|error| CatalogError::Request(error.to_string()))?;
    transport
        .writer
        .close_write()
        .map_err(|error| CatalogError::Request(error.to_string()))?;

    transport.reader.set_absolute_deadline(Some(deadline));
    read_catalog(&mut transport.reader, gateway_catalog_version)
}

/// What the box answered about one session's directory.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct SourceControlDocument {
    pub gateway_source_control_version: u16,
    #[serde(flatten)]
    pub body: SourceControlBody,
}

/// One document whatever happened.
///
/// `NotVersioned` is a fact and not a failure: a directory nothing versions is
/// a complete answer, and reporting it as an error sends somebody looking for a
/// network problem.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SourceControlBody {
    Read(SourceControlSnapshot),
    NotVersioned,
    Unavailable { reason: String },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct SourceControlSnapshot {
    /// Which reader answered. Named so a second one could exist without this
    /// side having to guess.
    pub vcs: String,
    pub root: String,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub ahead: Option<u32>,
    #[serde(default)]
    pub behind: Option<u32>,
    #[serde(default)]
    pub base_ref: Option<String>,
    /// What the file list was measured against — `merge_base` or `head`. The
    /// counts above answer a different question, and one screen must not
    /// present the two as one.
    pub comparison: String,
    #[serde(default)]
    pub files: Vec<SourceControlFile>,
    #[serde(default)]
    pub truncated: bool,
    /// The file list was actually read. Absent from a version-8 answer, where
    /// it was always true — the file list was the only thing v8 could be asked
    /// for.
    #[serde(default)]
    pub files_read: bool,
    /// Absent means this tab did not ask. An older box sends neither key.
    #[serde(default)]
    pub commits: Option<SourceControlCommits>,
    #[serde(default)]
    pub review: Option<SourceControlReview>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct SourceControlFile {
    pub path: String,
    pub status: String,
    #[serde(default)]
    pub old_path: Option<String>,
    /// Absent for a binary or untracked file. Absent, not zero.
    #[serde(default)]
    pub added: Option<u32>,
    #[serde(default)]
    pub deleted: Option<u32>,
}

/// What the commits tab got.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SourceControlCommits {
    Read {
        #[serde(default)]
        commits: Vec<SourceControlCommit>,
        #[serde(default)]
        truncated: bool,
    },
    Unavailable {
        reason: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct SourceControlCommit {
    pub short_sha: String,
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub when: String,
}

/// What the pull-request tab got.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SourceControlReview {
    /// Boxed: six strings beside two variants that carry a word. An internally
    /// tagged newtype variant reads the inner struct's fields beside `kind`, so
    /// the wire shape is the same one the gateway writes.
    Open(Box<SourceControlReviewOpen>),
    /// Asked, and there is none yet — the state a create button exists for.
    None,
    Unavailable {
        reason: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct SourceControlReviewOpen {
    pub number: u64,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub is_draft: bool,
    #[serde(default)]
    pub base_ref: String,
}

/// Asks one box what version control says about one of its sessions.
///
/// The read-only twin of [`list_sessions_over_ssh`], and served to a
/// forced-command key for the same reason: it names a session the caller was
/// already told about, and the box decides which directory that is.
///
/// There is no downgrade retry. The changes tab already sends the older
/// version byte for byte, so a refusal by version means commits or a review
/// was asked for — questions that box genuinely cannot answer. Retrying at the
/// older version would fetch the changed files and draw them under a heading
/// that asked for something else.
///
/// # Errors
/// When the SSH dial fails, the box refuses, or the answer is not one this
/// build understands.
pub fn source_control_status_over_ssh(
    ssh: SshExecConfig,
    request: SourceControlStatusRequest,
    timeout: Duration,
) -> Result<SourceControlDocument, CatalogError> {
    let mut transport = SshExecDialer::open_halves(ssh).map_err(CatalogError::Ssh)?;
    let encoded = encode_request(GatewayRequest::SourceControlStatus(request))?;
    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or_else(|| CatalogError::Request("the source control timeout overflowed".into()))?;
    transport
        .writer
        .write_frame_before(&encoded, Some(deadline))
        .map_err(|error| CatalogError::Request(error.to_string()))?;
    transport
        .writer
        .close_write()
        .map_err(|error| CatalogError::Request(error.to_string()))?;

    transport.reader.set_absolute_deadline(Some(deadline));
    let payload = read_answer(
        &mut transport.reader,
        FrameLimits::default().max_frame_bytes,
    )?
    .ok_or_else(|| {
        CatalogError::Response("the gateway returned no source control answer".into())
    })?;

    // The refusal is tried first, unlike the listing: an old box refuses this
    // question by version, and that is the expected answer from every box whose
    // hmux predates the reader — not an exceptional one.
    if let Ok(frame) = serde_json::from_slice::<WireFrame>(&payload) {
        if let FrameBody::Error(error) = frame.body {
            return Err(CatalogError::Refused {
                code: error.code,
                message: error.message,
            });
        }
    }
    let document = serde_json::from_slice::<SourceControlDocument>(&payload).map_err(|error| {
        CatalogError::Response(format!("the source control answer was unreadable: {error}"))
    })?;
    if document.gateway_source_control_version != SUPPORTED_SOURCE_CONTROL_VERSION {
        return Err(CatalogError::Response(format!(
            "the gateway speaks source control version {}; this build understands {}",
            document.gateway_source_control_version, SUPPORTED_SOURCE_CONTROL_VERSION
        )));
    }
    Ok(document)
}

/// What the box answered about one file's patch.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct FileDiffDocument {
    pub gateway_source_control_diff_version: u16,
    /// The path that was asked for, echoed back. A caller that has moved on to
    /// another row can tell the answers apart without holding a request table.
    pub path: String,
    /// From the listing that admitted the path. Absent means nobody counted —
    /// never zero as a stand-in.
    #[serde(default)]
    pub added: Option<u32>,
    #[serde(default)]
    pub deleted: Option<u32>,
    #[serde(flatten)]
    pub body: FileDiffBody,
}

/// One document whatever happened.
///
/// `Binary` is a fact and not a failure, and it is not an empty `Read` either:
/// an empty body means the file did not change, and drawing that for a PNG
/// claims the image is identical when nobody compared it.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FileDiffBody {
    Read {
        #[serde(default)]
        patch: String,
        #[serde(default)]
        truncated: bool,
    },
    Binary,
    Unavailable {
        reason: String,
    },
}

/// Asks one box for one file's patch.
///
/// The read-only twin of [`source_control_status_over_ssh`], and served to a
/// forced-command key for the same reason. There is no downgrade retry: a box
/// that refuses this version cannot answer the question at all, and retrying
/// with the status request would fetch a file *list* to draw under a heading
/// that asked for a patch.
///
/// # Errors
/// When the SSH dial fails, the box refuses, or the answer is not one this
/// build understands.
pub fn file_diff_over_ssh(
    ssh: SshExecConfig,
    request: SourceControlFileDiffRequest,
    timeout: Duration,
) -> Result<FileDiffDocument, CatalogError> {
    let mut transport = SshExecDialer::open_halves(ssh).map_err(CatalogError::Ssh)?;
    let encoded = encode_request(GatewayRequest::SourceControlFileDiff(request))?;
    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or_else(|| CatalogError::Request("the file diff timeout overflowed".into()))?;
    transport
        .writer
        .write_frame_before(&encoded, Some(deadline))
        .map_err(|error| CatalogError::Request(error.to_string()))?;
    transport
        .writer
        .close_write()
        .map_err(|error| CatalogError::Request(error.to_string()))?;

    transport.reader.set_absolute_deadline(Some(deadline));
    let payload = read_answer(
        &mut transport.reader,
        FrameLimits::default().max_frame_bytes,
    )?
    .ok_or_else(|| CatalogError::Response("the gateway returned no file diff answer".into()))?;

    // The refusal is tried first, for the same reason the status read does it:
    // every box whose hmux predates this request refuses by version, and that
    // is the expected answer rather than an exceptional one.
    if let Ok(frame) = serde_json::from_slice::<WireFrame>(&payload) {
        if let FrameBody::Error(error) = frame.body {
            return Err(CatalogError::Refused {
                code: error.code,
                message: error.message,
            });
        }
    }
    let document = serde_json::from_slice::<FileDiffDocument>(&payload).map_err(|error| {
        CatalogError::Response(format!("the file diff answer was unreadable: {error}"))
    })?;
    if document.gateway_source_control_diff_version != SUPPORTED_SOURCE_CONTROL_DIFF_VERSION {
        return Err(CatalogError::Response(format!(
            "the gateway speaks file diff version {}; this build understands {}",
            document.gateway_source_control_diff_version, SUPPORTED_SOURCE_CONTROL_DIFF_VERSION
        )));
    }
    Ok(document)
}

/// Creates or reuses one exact remote standalone shell through a normal SSH
/// login. A forced-command mobile key is refused by the remote gateway before
/// it can mutate state.
pub fn create_standalone_over_ssh(
    ssh: SshExecConfig,
    request: RemoteStandaloneCreateRequest,
    timeout: Duration,
) -> Result<RemoteStandaloneCreateReceipt, CatalogError> {
    validate_create_request(&request)?;
    let expected_request_id = request.request_id.clone();
    let expected_bridge_nonce = request.bridge_nonce.clone();
    let expected_retirement_policy = request.retirement_policy;
    let mut transport = SshExecDialer::open_halves(ssh).map_err(CatalogError::Ssh)?;
    let encoded = encode_request(GatewayRequest::CreateStandalone(request))?;
    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or_else(|| CatalogError::Request("the create timeout overflowed".into()))?;
    transport
        .writer
        .write_frame_before(&encoded, Some(deadline))
        .map_err(|error| CatalogError::Request(error.to_string()))?;
    transport
        .writer
        .close_write()
        .map_err(|error| CatalogError::Request(error.to_string()))?;
    transport.reader.set_absolute_deadline(Some(deadline));
    let payload = read_answer(
        &mut transport.reader,
        FrameLimits::default().max_frame_bytes,
    )?
    .ok_or_else(|| CatalogError::Response("the gateway returned no create receipt".into()))?;
    let document = match serde_json::from_slice::<StandaloneCreateDocument>(&payload) {
        Ok(document) => document,
        Err(create_error) => {
            if let Ok(frame) = serde_json::from_slice::<WireFrame>(&payload) {
                if let FrameBody::Error(error) = frame.body {
                    return Err(CatalogError::Refused {
                        code: error.code,
                        message: error.message,
                    });
                }
            }
            return Err(CatalogError::Response(format!(
                "could not decode a standalone create receipt: {create_error}"
            )));
        }
    };
    if document.gateway_create_version != 1 {
        return Err(CatalogError::Response(format!(
            "gateway_create_version {} is unsupported",
            document.gateway_create_version
        )));
    }
    if document.request_id != expected_request_id
        || document.bridge_nonce != expected_bridge_nonce
        || document.session.session_id.is_empty()
        || document.session.workspace_id.is_empty()
        || document.session.session_class != RemoteSessionClass::Standalone
        || document.session.lifecycle != RemoteSessionLifecycle::Ready
        || document.session.retirement_policy != expected_retirement_policy
    {
        return Err(CatalogError::Response(
            "the standalone create receipt did not match the exact request".into(),
        ));
    }
    finish_answer(
        &mut transport.reader,
        FrameLimits::default().max_frame_bytes,
    )?;
    Ok(RemoteStandaloneCreateReceipt {
        request_id: document.request_id,
        bridge_nonce: document.bridge_nonce,
        session: document.session,
    })
}

/// Abandons one exact standalone Host that was created but never presented.
///
/// This is intentionally a separate v3 gateway request rather than a relayed
/// attach capability. The ordinary SSH login is the outer authority, while the
/// remote Host still requires the launch-owner proof and the exact first
/// creator attachment generation before it can retire the session.
pub fn abandon_unpresented_creation_over_ssh(
    ssh: SshExecConfig,
    request: RemoteUnpresentedCreationAbandonRequest,
    timeout: Duration,
) -> Result<RemoteUnpresentedCreationAbandonReceipt, CatalogError> {
    validate_abandon_request(&request)?;
    let expected_request_id = request.request_id.clone();
    let expected_session_id = request.session_id.clone();
    let expected_workspace_id = request.workspace_id.clone();
    let mut transport = SshExecDialer::open_halves(ssh).map_err(CatalogError::Ssh)?;
    let encoded = encode_request(GatewayRequest::AbandonUnpresentedCreation(request))?;
    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or_else(|| CatalogError::Request("the abandon timeout overflowed".into()))?;
    transport
        .writer
        .write_frame_before(&encoded, Some(deadline))
        .map_err(|error| CatalogError::Request(error.to_string()))?;
    transport
        .writer
        .close_write()
        .map_err(|error| CatalogError::Request(error.to_string()))?;
    transport.reader.set_absolute_deadline(Some(deadline));
    let payload = read_answer(
        &mut transport.reader,
        FrameLimits::default().max_frame_bytes,
    )?
    .ok_or_else(|| CatalogError::Response("the gateway returned no abandon receipt".into()))?;
    let document = decode_abandon_document(&payload)?;
    validate_abandon_document(
        &document,
        &expected_request_id,
        &expected_session_id,
        &expected_workspace_id,
    )?;
    finish_answer(
        &mut transport.reader,
        FrameLimits::default().max_frame_bytes,
    )?;
    Ok(RemoteUnpresentedCreationAbandonReceipt {
        request_id: document.request_id,
        session_id: document.session_id,
        workspace_id: document.workspace_id,
        receipt: document.receipt,
    })
}

/// Writes one bounded input through a shared writer on the session's machine.
///
/// This is a gateway action rather than a relayed `SharedWriter` attach: the
/// latter has no same-kernel identity witness and is intentionally refused.
/// The gateway resolves and fence-checks the session locally, then returns the
/// Host's exact `written_to_pty` receipt without acquiring the UI controller.
pub fn write_session_input_over_ssh(
    ssh: SshExecConfig,
    request: RemoteSessionInputRequest,
    timeout: Duration,
) -> Result<RemoteSessionInputReceipt, CatalogError> {
    validate_session_input_request(&request)?;
    let expected_request_id = request.request_id.clone();
    let expected_session_id = request.expected_fence.session_id.clone();
    let expected_workspace_id = request.expected_fence.workspace_id.clone();
    let mut transport = SshExecDialer::open_halves(ssh).map_err(CatalogError::Ssh)?;
    let encoded = encode_request(GatewayRequest::WriteSessionInput(request))?;
    let deadline = Instant::now()
        .checked_add(timeout)
        .ok_or_else(|| CatalogError::Request("the input timeout overflowed".into()))?;
    transport
        .writer
        .write_frame_before(&encoded, Some(deadline))
        .map_err(|error| CatalogError::Request(error.to_string()))?;
    transport
        .writer
        .close_write()
        .map_err(|error| CatalogError::Request(error.to_string()))?;
    transport.reader.set_absolute_deadline(Some(deadline));
    let payload = read_answer(
        &mut transport.reader,
        FrameLimits::default().max_frame_bytes,
    )?
    .ok_or_else(|| CatalogError::Response("the gateway returned no input receipt".into()))?;
    let document = decode_session_input_document(&payload)?;
    validate_session_input_document(
        &document,
        &expected_request_id,
        &expected_session_id,
        &expected_workspace_id,
    )?;
    finish_answer(
        &mut transport.reader,
        FrameLimits::default().max_frame_bytes,
    )?;
    Ok(RemoteSessionInputReceipt {
        request_id: document.request_id,
        session_id: document.session_id,
        workspace_id: document.workspace_id,
        receipt: document.receipt,
    })
}

fn encode_request(request: GatewayRequest) -> Result<Vec<u8>, CatalogError> {
    encode_request_with_listing_version(request, GATEWAY_REQUEST_VERSION_GATEWAY_BUILD)
}

fn encode_request_with_listing_version(
    request: GatewayRequest,
    listing_version: u16,
) -> Result<Vec<u8>, CatalogError> {
    let gateway_request_version = match &request {
        GatewayRequest::ListSessions => listing_version,
        // The version comes from the shape, not from this build's ceiling: one
        // version admits exactly one shape on the far side.
        GatewayRequest::SourceControlStatus(request) if request.want.is_some() => {
            GATEWAY_REQUEST_VERSION_SOURCE_CONTROL_WANT
        }
        GatewayRequest::SourceControlStatus(_) => GATEWAY_REQUEST_VERSION_SOURCE_CONTROL,
        GatewayRequest::CreateStandalone(request) if request.cwd.is_some() => {
            GATEWAY_REQUEST_VERSION_WORKING_DIRECTORY
        }
        GatewayRequest::CreateStandalone(request) if request.retirement_policy.is_some() => {
            GATEWAY_REQUEST_VERSION_RETIREMENT_POLICY
        }
        GatewayRequest::CreateStandalone(_) => GATEWAY_REQUEST_VERSION_V1,
        GatewayRequest::AbandonUnpresentedCreation(_) => {
            GATEWAY_REQUEST_VERSION_ABANDON_UNPRESENTED_CREATION
        }
        GatewayRequest::WriteSessionInput(_) => GATEWAY_REQUEST_VERSION_EXACT_INPUT,
        GatewayRequest::SourceControlFileDiff(_) => GATEWAY_REQUEST_VERSION_SOURCE_CONTROL_DIFF,
        GatewayRequest::ResolveSession(_) => session_resolution::GATEWAY_REQUEST_VERSION,
    };
    let payload = serde_json::to_vec(&GatewayRequestDocument {
        gateway_request_version,
        request,
    })
    .map_err(|error| CatalogError::Request(error.to_string()))?;
    let maximum = FrameLimits::default().max_frame_bytes;
    if payload.len() > maximum {
        return Err(CatalogError::Request(format!(
            "the request exceeded the {maximum}-byte frame limit"
        )));
    }
    let length = u32::try_from(payload.len())
        .map_err(|_| CatalogError::Request("the request length overflowed u32".into()))?;
    let mut encoded = Vec::with_capacity(LENGTH_PREFIX_BYTES + payload.len());
    encoded.extend_from_slice(&length.to_be_bytes());
    encoded.extend_from_slice(&payload);
    Ok(encoded)
}

pub(crate) fn validate_create_request(
    request: &RemoteStandaloneCreateRequest,
) -> Result<(), CatalogError> {
    let identifiers = [
        ("request id", request.request_id.as_str()),
        ("target session id", request.target_session_id.as_str()),
        ("launch owner proof", request.launch_owner_proof.as_str()),
        ("session name", request.session_name.as_str()),
        ("bridge nonce", request.bridge_nonce.as_str()),
    ];
    for (label, value) in identifiers {
        if value.is_empty()
            || value.len() > 256
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._:+-".contains(&byte))
        {
            return Err(CatalogError::Request(format!(
                "the remote standalone {label} is invalid"
            )));
        }
    }
    if request.initial_rows == 0
        || request.initial_columns == 0
        || request.command_intercepts.is_empty()
        || request.command_intercepts.len() > 16
        || request
            .retirement_policy
            .is_some_and(|policy| !policy.is_valid())
    {
        return Err(CatalogError::Request(
            "the remote standalone dimensions or command intercepts are invalid".into(),
        ));
    }
    if request
        .cwd
        .as_ref()
        .is_some_and(|cwd| cwd.is_empty() || cwd.len() > 4_096 || cwd.as_bytes().contains(&0))
    {
        return Err(CatalogError::Request(
            "the remote standalone working directory is invalid".into(),
        ));
    }
    let mut commands = BTreeSet::new();
    for intercept in &request.command_intercepts {
        for (label, value) in [
            ("command", intercept.command.as_str()),
            ("provider id", intercept.provider_id.as_str()),
        ] {
            if value.is_empty()
                || value.len() > 64
                || !value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._+-".contains(&byte))
            {
                return Err(CatalogError::Request(format!(
                    "the remote standalone intercept {label} is invalid"
                )));
            }
        }
        if !commands.insert(intercept.command.as_str()) {
            return Err(CatalogError::Request(
                "the remote standalone intercept commands must be unique".into(),
            ));
        }
    }
    Ok(())
}

fn validate_abandon_request(
    request: &RemoteUnpresentedCreationAbandonRequest,
) -> Result<(), CatalogError> {
    for (label, value) in [
        ("request id", request.request_id.as_str()),
        ("session id", request.session_id.as_str()),
        ("workspace id", request.workspace_id.as_str()),
        ("launch owner proof", request.launch_owner_proof.as_str()),
    ] {
        if value.is_empty()
            || value.len() > 256
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._:+-".contains(&byte))
        {
            return Err(CatalogError::Request(format!(
                "the remote unpresented creation abandon {label} is invalid"
            )));
        }
    }
    Ok(())
}

fn validate_session_input_request(request: &RemoteSessionInputRequest) -> Result<(), CatalogError> {
    for (label, value) in [
        ("request id", request.request_id.as_str()),
        ("session id", request.expected_fence.session_id.as_str()),
        ("workspace id", request.expected_fence.workspace_id.as_str()),
        (
            "runner principal",
            request.expected_fence.runner_principal.as_str(),
        ),
        (
            "runner instance",
            request.expected_fence.runner_instance.as_str(),
        ),
        (
            "host instance id",
            request.expected_fence.host_instance_id.as_str(),
        ),
        (
            "terminal epoch",
            request.expected_fence.terminal_epoch.as_str(),
        ),
    ] {
        if value.is_empty()
            || value.len() > 256
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._:+-".contains(&byte))
        {
            return Err(CatalogError::Request(format!(
                "the remote session input {label} is invalid"
            )));
        }
    }
    if request.expected_fence.channel_epoch == 0
        || request.bytes.is_empty()
        || request.bytes.len() > MAX_REMOTE_SESSION_INPUT_BYTES
    {
        return Err(CatalogError::Request(format!(
            "remote session input must contain 1..={MAX_REMOTE_SESSION_INPUT_BYTES} bytes and a non-zero channel epoch"
        )));
    }
    Ok(())
}

fn decode_abandon_document(
    payload: &[u8],
) -> Result<AbandonUnpresentedCreationDocument, CatalogError> {
    match serde_json::from_slice::<AbandonUnpresentedCreationDocument>(payload) {
        Ok(document) => Ok(document),
        Err(abandon_error) => {
            if let Ok(frame) = serde_json::from_slice::<WireFrame>(payload) {
                if let FrameBody::Error(error) = frame.body {
                    return Err(CatalogError::Refused {
                        code: error.code,
                        message: error.message,
                    });
                }
            }
            Err(CatalogError::Response(format!(
                "could not decode an unpresented creation abandon receipt: {abandon_error}"
            )))
        }
    }
}

fn validate_abandon_document(
    document: &AbandonUnpresentedCreationDocument,
    expected_request_id: &str,
    expected_session_id: &str,
    expected_workspace_id: &str,
) -> Result<(), CatalogError> {
    if document.gateway_abandon_version != 1 {
        return Err(CatalogError::Response(format!(
            "gateway_abandon_version {} is unsupported",
            document.gateway_abandon_version
        )));
    }
    if document.request_id != expected_request_id
        || document.session_id != expected_session_id
        || document.workspace_id != expected_workspace_id
    {
        return Err(CatalogError::Response(
            "the abandon receipt did not match the exact request".into(),
        ));
    }
    WireFrame {
        protocol_version: PROTOCOL_V1,
        frame_id: 1,
        body: FrameBody::SessionRetirementReceipt(document.receipt.clone()),
    }
    .validate(&FrameLimits::default())
    .map_err(|error| {
        CatalogError::Response(format!(
            "the abandon receipt carried an invalid session retirement receipt: {error}"
        ))
    })
}

fn decode_session_input_document(payload: &[u8]) -> Result<SessionInputDocument, CatalogError> {
    match serde_json::from_slice::<SessionInputDocument>(payload) {
        Ok(document) => Ok(document),
        Err(input_error) => {
            if let Ok(frame) = serde_json::from_slice::<WireFrame>(payload) {
                if let FrameBody::Error(error) = frame.body {
                    return Err(CatalogError::Refused {
                        code: error.code,
                        message: error.message,
                    });
                }
            }
            Err(CatalogError::Response(format!(
                "could not decode a session input receipt: {input_error}"
            )))
        }
    }
}

fn validate_session_input_document(
    document: &SessionInputDocument,
    expected_request_id: &str,
    expected_session_id: &str,
    expected_workspace_id: &str,
) -> Result<(), CatalogError> {
    if document.gateway_input_version != 1
        || document.request_id != expected_request_id
        || document.session_id != expected_session_id
        || document.workspace_id != expected_workspace_id
        || document.receipt.state != InputReceiptState::WrittenToPty
    {
        return Err(CatalogError::Response(
            "the input receipt did not match the exact request".into(),
        ));
    }
    WireFrame {
        protocol_version: PROTOCOL_V1,
        frame_id: 1,
        body: FrameBody::InputReceipt(document.receipt.clone()),
    }
    .validate(&FrameLimits::default())
    .map_err(|error| {
        CatalogError::Response(format!(
            "the gateway carried an invalid input receipt: {error}"
        ))
    })
}

fn read_catalog(
    reader: &mut crate::SshFrameReader,
    expected_catalog_version: u16,
) -> Result<Vec<RemoteCatalogSession>, CatalogError> {
    let maximum = FrameLimits::default().max_frame_bytes;
    let mut sessions = Vec::new();
    loop {
        let Some(payload) = read_document(reader, maximum)? else {
            let completion = reader.wait_for_completion().map_err(response_io)?;
            return match completion.failure_detail() {
                Some(_) => Err(CatalogError::CommandFailed(completion)),
                None => Ok(sessions),
            };
        };
        match decode_catalog_document(&payload) {
            Ok(document) => {
                require_catalog_version(&document, expected_catalog_version)?;
                if sessions.len() == MAX_CATALOG_SESSIONS {
                    return Err(CatalogError::Response(format!(
                        "the catalog exceeded {MAX_CATALOG_SESSIONS} sessions"
                    )));
                }
                let _forced_command_applied = document.forced_command_applied;
                sessions.push(session_from_catalog_document(document));
            }
            Err(catalog_error) => {
                if let Ok(frame) = serde_json::from_slice::<WireFrame>(&payload) {
                    if let FrameBody::Error(error) = frame.body {
                        return Err(CatalogError::Refused {
                            code: error.code,
                            message: error.message,
                        });
                    }
                }
                return Err(catalog_error);
            }
        }
    }
}

fn session_from_catalog_document(mut document: CatalogDocument) -> RemoteCatalogSession {
    document.session.gateway_build_id = document.gateway_build_id;
    document.session
}

fn require_catalog_version(
    document: &CatalogDocument,
    expected_catalog_version: u16,
) -> Result<(), CatalogError> {
    if document.gateway_catalog_version != expected_catalog_version {
        return Err(CatalogError::Response(format!(
            "gateway_catalog_version {} did not match negotiated version {expected_catalog_version}",
            document.gateway_catalog_version
        )));
    }
    Ok(())
}

fn decode_catalog_document(payload: &[u8]) -> Result<CatalogDocument, CatalogError> {
    let document = serde_json::from_slice::<CatalogDocument>(payload).map_err(|error| {
        CatalogError::Response(format!("could not decode a catalog document: {error}"))
    })?;
    match document.gateway_catalog_version {
        GATEWAY_CATALOG_VERSION_V1 => {
            let value = serde_json::from_slice::<serde_json::Value>(payload).map_err(|error| {
                CatalogError::Response(format!("could not inspect a v1 catalog document: {error}"))
            })?;
            let session = value.get("session").and_then(serde_json::Value::as_object);
            if document.gateway_build_id.is_some()
                || session.is_some_and(|session| {
                    session.contains_key("retirement_policy")
                        || session.contains_key("launch_program")
                        || session.contains_key("host_liveness")
                })
            {
                return Err(CatalogError::Response(
                    "a gateway_catalog_version 1 document carried newer fields".into(),
                ));
            }
        }
        GATEWAY_CATALOG_VERSION_RETIREMENT_POLICY => {
            let value = serde_json::from_slice::<serde_json::Value>(payload).map_err(|error| {
                CatalogError::Response(format!("could not inspect a v2 catalog document: {error}"))
            })?;
            let session = value.get("session").and_then(serde_json::Value::as_object);
            if document.gateway_build_id.is_some()
                || session.is_some_and(|session| {
                    session.contains_key("launch_program") || session.contains_key("host_liveness")
                })
            {
                return Err(CatalogError::Response(
                    "a gateway_catalog_version 2 document carried session-fact fields".into(),
                ));
            }
        }
        GATEWAY_CATALOG_VERSION_SESSION_FACTS => {
            let invalid_build_id = document
                .gateway_build_id
                .as_deref()
                .is_some_and(|build_id| {
                    build_id.is_empty()
                        || build_id.len() > 256
                        || !build_id
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || b"._+-".contains(&byte))
                });
            if invalid_build_id || document.session.host_liveness.is_none() {
                return Err(CatalogError::Response(
                    "a gateway_catalog_version 3 document carried invalid session facts".into(),
                ));
            }
        }
        GATEWAY_CATALOG_VERSION_GATEWAY_BUILD => {
            let valid_build_id = document
                .gateway_build_id
                .as_deref()
                .is_some_and(|build_id| {
                    !build_id.is_empty()
                        && build_id.len() <= 256
                        && build_id
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || b"._+-".contains(&byte))
                });
            if !valid_build_id || document.session.host_liveness.is_none() {
                return Err(CatalogError::Response(
                    "a gateway_catalog_version 4 document carried invalid gateway facts".into(),
                ));
            }
        }
        version => {
            return Err(CatalogError::Response(format!(
                "gateway_catalog_version {version} is unsupported"
            )));
        }
    }
    Ok(document)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channel::ChannelEvent;
    use crate::harness::Harness;
    use std::io::Cursor;

    const PATIENCE: Duration = Duration::from_secs(5);

    fn document(session_id: &str) -> Vec<u8> {
        let payload = serde_json::json!({
            "gateway_catalog_version": 1,
            "session": {
                "session_id": session_id,
                "session_name": "shell",
                "workspace_id": "workspace-1",
                "session_class": "standalone",
                "lifecycle": "ready",
                "provider_id": "shell",
                "runner_principal": "principal",
                "runner_instance": "instance",
                "channel_epoch": "7",
                "host_instance_id": "host-instance",
                "terminal_epoch": "terminal-epoch",
                "supported_protocol": {
                    "minimum": { "major": 1, "minor": 0 },
                    "maximum": { "major": 1, "minor": 0 }
                },
                "capabilities": ["screen_snapshot"]
            }
        });
        let payload = serde_json::to_vec(&payload).unwrap();
        let mut encoded = Vec::new();
        encoded.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        encoded.extend_from_slice(&payload);
        encoded
    }

    fn document_with_retirement_policy(session_id: &str) -> Vec<u8> {
        let payload = serde_json::json!({
            "gateway_catalog_version": 2,
            "session": {
                "session_id": session_id,
                "session_name": "shell",
                "workspace_id": "workspace-1",
                "session_class": "standalone",
                "lifecycle": "ready",
                "provider_id": "shell",
                "runner_principal": "principal",
                "runner_instance": "instance",
                "channel_epoch": "7",
                "host_instance_id": "host-instance",
                "terminal_epoch": "terminal-epoch",
                "supported_protocol": {
                    "minimum": { "major": 1, "minor": 0 },
                    "maximum": { "major": 1, "minor": 0 }
                },
                "capabilities": ["screen_snapshot", "session_retirement_v1"],
                "retirement_policy": {
                    "kind": "after_graceful_last_client_departure_v1",
                    "grace_period_ms": "2000"
                }
            }
        });
        let payload = serde_json::to_vec(&payload).unwrap();
        let mut encoded = Vec::new();
        encoded.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        encoded.extend_from_slice(&payload);
        encoded
    }

    fn input_request(bytes: Vec<u8>) -> RemoteSessionInputRequest {
        RemoteSessionInputRequest {
            request_id: "request-input-1".into(),
            expected_fence: SessionFence {
                workspace_id: "remote-workspace".into(),
                session_id: "remote-session".into(),
                runner_principal: "principal".into(),
                runner_instance: "instance".into(),
                channel_epoch: 7,
                host_instance_id: "host-instance".into(),
                terminal_epoch: "terminal-epoch".into(),
            },
            bytes,
        }
    }

    fn document_with_session_facts(session_id: &str) -> Vec<u8> {
        let payload = serde_json::json!({
            "gateway_catalog_version": 4,
            "gateway_build_id": "build-current",
            "session": {
                "session_id": session_id,
                "session_name": "shell",
                "workspace_id": "workspace-1",
                "session_class": "standalone",
                "lifecycle": "ready",
                "provider_id": "shell",
                "runner_principal": "principal",
                "runner_instance": "instance",
                "channel_epoch": "7",
                "host_instance_id": "host-instance",
                "terminal_epoch": "terminal-epoch",
                "supported_protocol": {
                    "minimum": { "major": 1, "minor": 0 },
                    "maximum": { "major": 1, "minor": 0 }
                },
                "capabilities": ["screen_snapshot"],
                "launch_program": "zsh",
                "host_liveness": "live"
            }
        });
        let payload = serde_json::to_vec(&payload).unwrap();
        let mut encoded = Vec::new();
        encoded.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        encoded.extend_from_slice(&payload);
        encoded
    }

    #[test]
    fn listing_requests_the_gateway_build_catalog_and_keeps_the_v4_fallback() {
        let encoded = encode_request(GatewayRequest::ListSessions).unwrap();
        let length = u32::from_be_bytes(encoded[..4].try_into().unwrap()) as usize;
        assert_eq!(length, encoded.len() - 4);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&encoded[4..]).unwrap(),
            serde_json::json!({
                "gateway_request_version": 6,
                "request": "list_sessions"
            })
        );

        let compatible = encode_request_with_listing_version(
            GatewayRequest::ListSessions,
            GATEWAY_REQUEST_VERSION_RETIREMENT_POLICY,
        )
        .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&compatible[4..]).unwrap(),
            serde_json::json!({
                "gateway_request_version": 2,
                "request": "list_sessions"
            })
        );
    }

    #[test]
    fn only_a_typed_version_refusal_allows_catalog_fallback() {
        let unsupported = CatalogError::Refused {
            code: hmux_session_protocol::ErrorCode::UnsupportedProtocolVersion,
            message: "upgrade the gateway".into(),
        };
        assert!(unsupported.is_unsupported_protocol_version());

        let unauthorized = CatalogError::Refused {
            code: hmux_session_protocol::ErrorCode::AuthorizationDenied,
            message: "not allowed".into(),
        };
        assert!(!unauthorized.is_unsupported_protocol_version());
    }

    #[test]
    fn standalone_create_request_is_strict_bounded_and_provider_neutral() {
        let request = RemoteStandaloneCreateRequest {
            request_id: "request-1".into(),
            target_session_id: "standalone-1".into(),
            launch_owner_proof: "launch-proof-1".into(),
            session_name: "remote-shell".into(),
            bridge_nonce: "bridge-nonce-1".into(),
            cwd: None,
            initial_rows: 40,
            initial_columns: 120,
            command_intercepts: vec![
                RemoteCommandIntercept {
                    command: "claude".into(),
                    provider_id: "claude".into(),
                },
                RemoteCommandIntercept {
                    command: "codex".into(),
                    provider_id: "codex".into(),
                },
            ],
            retirement_policy: None,
        };
        validate_create_request(&request).unwrap();
        assert!(format!("{request:?}").contains("<redacted>"));
        assert!(!format!("{request:?}").contains("launch-proof-1"));
        let encoded = encode_request(GatewayRequest::CreateStandalone(request)).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&encoded[4..]).unwrap();
        assert_eq!(value["gateway_request_version"], 1);
        assert_eq!(
            value["request"]["create_standalone"]["command_intercepts"][1]["command"],
            "codex"
        );
        let serialized = value.to_string();
        assert!(!serialized.contains("credential"));
        assert!(!serialized.contains("password"));
        assert!(!serialized.contains("token"));
    }

    #[test]
    fn standalone_create_request_refuses_duplicate_intercepts() {
        let mut request = RemoteStandaloneCreateRequest {
            request_id: "request-1".into(),
            target_session_id: "standalone-1".into(),
            launch_owner_proof: "launch-proof-1".into(),
            session_name: "remote-shell".into(),
            bridge_nonce: "bridge-nonce-1".into(),
            cwd: None,
            initial_rows: 40,
            initial_columns: 120,
            command_intercepts: vec![
                RemoteCommandIntercept {
                    command: "codex".into(),
                    provider_id: "codex".into(),
                },
                RemoteCommandIntercept {
                    command: "codex".into(),
                    provider_id: "other".into(),
                },
            ],
            retirement_policy: None,
        };
        assert!(validate_create_request(&request).is_err());
        request.command_intercepts.pop();
        validate_create_request(&request).unwrap();
    }

    #[test]
    fn retirement_policy_uses_additive_gateway_request_version_two() {
        let mut request = RemoteStandaloneCreateRequest {
            request_id: "request-1".into(),
            target_session_id: "standalone-1".into(),
            launch_owner_proof: "launch-proof-1".into(),
            session_name: "remote-shell".into(),
            bridge_nonce: "bridge-nonce-1".into(),
            cwd: None,
            initial_rows: 40,
            initial_columns: 120,
            command_intercepts: vec![RemoteCommandIntercept {
                command: "codex".into(),
                provider_id: "codex".into(),
            }],
            retirement_policy: Some(
                SessionRetirementPolicy::AfterGracefulLastClientDepartureV1 {
                    grace_period_ms: 2_000,
                },
            ),
        };

        let encoded = encode_request(GatewayRequest::CreateStandalone(request.clone())).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&encoded[4..]).unwrap();

        assert_eq!(value["gateway_request_version"], 2);
        assert_eq!(
            value["request"]["create_standalone"]["retirement_policy"]["kind"],
            "after_graceful_last_client_departure_v1"
        );
        assert_eq!(
            value["request"]["create_standalone"]["retirement_policy"]["grace_period_ms"],
            "2000"
        );

        request.cwd = Some("/home/tester/project".into());
        validate_create_request(&request).unwrap();
        let encoded = encode_request(GatewayRequest::CreateStandalone(request)).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&encoded[4..]).unwrap();
        assert_eq!(value["gateway_request_version"], 7);
        assert_eq!(
            value["request"]["create_standalone"]["cwd"],
            "/home/tester/project"
        );
    }

    #[test]
    fn unpresented_creation_abandon_uses_exclusive_gateway_request_version_three() {
        let request = RemoteUnpresentedCreationAbandonRequest {
            request_id: "request-1".into(),
            session_id: "standalone-1".into(),
            workspace_id: "workspace-1".into(),
            launch_owner_proof: "launch-proof-1".into(),
        };
        validate_abandon_request(&request).unwrap();
        assert!(!format!("{request:?}").contains("launch-proof-1"));
        let encoded = encode_request(GatewayRequest::AbandonUnpresentedCreation(request)).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&encoded[4..]).unwrap();

        assert_eq!(value["gateway_request_version"], 3);
        assert_eq!(
            value["request"]["abandon_unpresented_creation"]["request_id"],
            "request-1"
        );
        assert_eq!(
            value["request"]["abandon_unpresented_creation"]["session_id"],
            "standalone-1"
        );
        assert_eq!(
            value["request"]["abandon_unpresented_creation"]["workspace_id"],
            "workspace-1"
        );
        assert_eq!(
            value["request"]["abandon_unpresented_creation"]["launch_owner_proof"],
            "launch-proof-1"
        );
    }

    #[test]
    fn exact_input_uses_version_five_and_redacts_terminal_bytes() {
        let request = input_request(b"private terminal input\r".to_vec());
        validate_session_input_request(&request).unwrap();
        let debug = format!("{request:?}");
        assert!(debug.contains("byte_length"));
        assert!(!debug.contains("private terminal input"));

        let encoded = encode_request(GatewayRequest::WriteSessionInput(request)).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&encoded[4..]).unwrap();
        assert_eq!(value["gateway_request_version"], 5);
        assert_eq!(
            value["request"]["write_session_input"]["expected_fence"]["session_id"],
            "remote-session"
        );
        assert_eq!(
            value["request"]["write_session_input"]["expected_fence"]["channel_epoch"],
            "7"
        );
    }

    #[test]
    fn exact_input_is_bounded_before_opening_ssh() {
        assert!(validate_session_input_request(&input_request(Vec::new())).is_err());
        assert!(
            validate_session_input_request(&input_request(vec![
                b'x';
                MAX_REMOTE_SESSION_INPUT_BYTES + 1
            ]))
            .is_err()
        );
        let mut stale = input_request(b"status\r".to_vec());
        stale.expected_fence.channel_epoch = 0;
        assert!(validate_session_input_request(&stale).is_err());
    }

    #[test]
    fn exact_input_receipt_requires_outer_identity_and_written_host_receipt() {
        let payload = serde_json::to_vec(&serde_json::json!({
            "gateway_input_version": 1,
            "request_id": "request-input-1",
            "session_id": "remote-session",
            "workspace_id": "remote-workspace",
            "receipt": {
                "request_id": "external-input-1",
                "controller_generation": "9",
                "state": "written_to_pty",
                "reason": null
            }
        }))
        .unwrap();
        let document = decode_session_input_document(&payload).unwrap();
        validate_session_input_document(
            &document,
            "request-input-1",
            "remote-session",
            "remote-workspace",
        )
        .unwrap();

        assert!(
            validate_session_input_document(
                &document,
                "other-request",
                "remote-session",
                "remote-workspace",
            )
            .unwrap_err()
            .to_string()
            .contains("exact request")
        );
        let mut refused = serde_json::from_slice::<serde_json::Value>(&payload).unwrap();
        refused["receipt"]["state"] = "refused".into();
        assert!(
            validate_session_input_document(
                &decode_session_input_document(&serde_json::to_vec(&refused).unwrap()).unwrap(),
                "request-input-1",
                "remote-session",
                "remote-workspace",
            )
            .is_err()
        );
    }

    #[test]
    fn exact_input_preserves_an_old_gateway_version_refusal_as_a_typed_code() {
        let payload = serde_json::to_vec(&WireFrame {
            protocol_version: PROTOCOL_V1,
            frame_id: 1,
            body: FrameBody::Error(hmux_session_protocol::ErrorFrame {
                origin_code: None,
                code: hmux_session_protocol::ErrorCode::UnsupportedProtocolVersion,
                message: "this gateway serves gateway_request_version 1..=4, not 5".into(),
                retry: hmux_session_protocol::RetryPosture::Never,
                required_capability: None,
                supported_versions: None,
                in_reply_to_request_id: None,
            }),
        })
        .unwrap();

        let error = match decode_session_input_document(&payload) {
            Ok(_) => panic!("a frozen v4 gateway must refuse a v5-only input request"),
            Err(error) => error,
        };

        assert_eq!(error.code(), "hmux_protocol_version_unsupported");
        assert!(error.to_string().contains("1..=4, not 5"));
    }

    #[test]
    fn abandon_receipt_requires_exact_outer_identity_and_valid_typed_receipt() {
        let payload = serde_json::to_vec(&serde_json::json!({
            "gateway_abandon_version": 1,
            "request_id": "request-1",
            "session_id": "standalone-1",
            "workspace_id": "workspace-1",
            "receipt": {
                "request_id": "host-retirement-1",
                "state": "refused",
                "reason": "generation_changed"
            }
        }))
        .unwrap();
        let document = decode_abandon_document(&payload).unwrap();
        validate_abandon_document(&document, "request-1", "standalone-1", "workspace-1").unwrap();

        assert!(
            validate_abandon_document(
                &document,
                "different-request",
                "standalone-1",
                "workspace-1",
            )
            .unwrap_err()
            .to_string()
            .contains("exact request")
        );

        let mut invalid = serde_json::from_slice::<serde_json::Value>(&payload).unwrap();
        invalid["receipt"]["reason"] = serde_json::Value::Null;
        let invalid = decode_abandon_document(&serde_json::to_vec(&invalid).unwrap()).unwrap();
        assert!(
            validate_abandon_document(&invalid, "request-1", "standalone-1", "workspace-1",)
                .unwrap_err()
                .to_string()
                .contains("invalid session retirement receipt")
        );
    }

    #[test]
    fn catalog_document_exposes_identity_without_transport_secrets() {
        let encoded = document("session-1");
        let payload = &encoded[4..];
        let parsed = decode_catalog_document(payload).unwrap();
        assert_eq!(parsed.session.session_id, "session-1");
        assert_eq!(parsed.session.channel_epoch, "7");
        assert_eq!(parsed.session.retirement_policy, None);
        require_catalog_version(&parsed, GATEWAY_CATALOG_VERSION_V1).unwrap();
        assert!(
            require_catalog_version(&parsed, GATEWAY_CATALOG_VERSION_RETIREMENT_POLICY,)
                .unwrap_err()
                .to_string()
                .contains("negotiated version 2"),
            "a v2 refresh must not silently downgrade to a policy-blind v1 catalog"
        );

        let mut value = serde_json::from_slice::<serde_json::Value>(payload).unwrap();
        value["session"]["capability_token"] = "must-not-cross-ssh".into();
        assert!(serde_json::from_value::<CatalogDocument>(value).is_err());
    }

    #[test]
    fn catalog_v2_exposes_policy_without_weakening_the_v1_shape() {
        let encoded = document_with_retirement_policy("session-1");
        let parsed = decode_catalog_document(&encoded[4..]).unwrap();
        assert_eq!(parsed.gateway_catalog_version, 2);
        assert_eq!(
            parsed.session.retirement_policy,
            Some(
                SessionRetirementPolicy::AfterGracefulLastClientDepartureV1 {
                    grace_period_ms: 2_000,
                }
            )
        );

        let mut v1 = serde_json::from_slice::<serde_json::Value>(&encoded[4..]).unwrap();
        v1["gateway_catalog_version"] = 1.into();
        let error = match decode_catalog_document(&serde_json::to_vec(&v1).unwrap()) {
            Ok(_) => panic!("v1 must retain the legacy session shape"),
            Err(error) => error,
        };
        assert!(
            error.to_string().contains("version 1"),
            "unexpected compatibility refusal: {error}"
        );
    }

    #[test]
    fn catalog_v4_requires_a_build_while_v3_preserves_both_deployed_shapes() {
        let encoded = document_with_session_facts("session-1");
        let document = decode_catalog_document(&encoded[4..]).unwrap();
        require_catalog_version(&document, GATEWAY_CATALOG_VERSION_GATEWAY_BUILD).unwrap();
        let session = session_from_catalog_document(document);
        assert_eq!(session.gateway_build_id.as_deref(), Some("build-current"));
        assert_eq!(session.launch_program.as_deref(), Some("zsh"));
        assert_eq!(session.host_liveness, Some(RemoteHostLiveness::Live));

        let mut shipped = serde_json::from_slice::<serde_json::Value>(&encoded[4..]).unwrap();
        shipped["gateway_catalog_version"] = 3.into();
        shipped.as_object_mut().unwrap().remove("gateway_build_id");
        let shipped = decode_catalog_document(&serde_json::to_vec(&shipped).unwrap()).unwrap();
        let shipped = session_from_catalog_document(shipped);
        assert_eq!(shipped.gateway_build_id, None);
        assert_eq!(shipped.launch_program.as_deref(), Some("zsh"));
        assert_eq!(shipped.host_liveness, Some(RemoteHostLiveness::Live));

        let mut interstitial = serde_json::from_slice::<serde_json::Value>(&encoded[4..]).unwrap();
        interstitial["gateway_catalog_version"] = 3.into();
        let interstitial =
            decode_catalog_document(&serde_json::to_vec(&interstitial).unwrap()).unwrap();
        assert_eq!(
            session_from_catalog_document(interstitial)
                .gateway_build_id
                .as_deref(),
            Some("build-current"),
            "clients must survive the deployed v3 gateway that already emitted the field"
        );

        let mut invalid = serde_json::from_slice::<serde_json::Value>(&encoded[4..]).unwrap();
        invalid["gateway_build_id"] = "".into();
        let error = match decode_catalog_document(&serde_json::to_vec(&invalid).unwrap()) {
            Ok(_) => panic!("a v4 gateway build must remain bounded and valid"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("invalid gateway facts"));
    }

    #[test]
    fn response_reader_accepts_short_reads_and_rejects_truncation() {
        let mut bytes = document("session-1");
        bytes.extend(document("session-2"));
        let mut cursor = Cursor::new(bytes);
        let first = read_document(&mut cursor, 1024 * 1024).unwrap().unwrap();
        let second = read_document(&mut cursor, 1024 * 1024).unwrap().unwrap();
        assert!(read_document(&mut cursor, 1024 * 1024).unwrap().is_none());
        assert_eq!(
            serde_json::from_slice::<CatalogDocument>(&first)
                .unwrap()
                .session
                .session_id,
            "session-1"
        );
        assert_eq!(
            serde_json::from_slice::<CatalogDocument>(&second)
                .unwrap()
                .session
                .session_id,
            "session-2"
        );

        let mut truncated = Cursor::new(document("session-3")[..12].to_vec());
        assert!(
            read_document(&mut truncated, 1024 * 1024)
                .unwrap_err()
                .to_string()
                .contains("closed inside")
        );
    }

    /// The channel a remote that never ran the gateway leaves behind: the
    /// reason on stderr, the data half closed, and only then the status.
    /// `$HOME/.local/bin/hmux` being absent and a Windows `cmd.exe` that
    /// cannot parse the invocation both look exactly like this; the second is
    /// what a real host produced on 2026-09-02, and the IDE reported it as a
    /// missing create receipt.
    #[test]
    fn a_command_that_failed_before_answering_is_reported_by_its_reason() {
        let harness = Harness::new(vec![]);
        harness
            .events
            .send(ChannelEvent::Diagnostic(
                b"The system cannot find the path specified.\r\n".to_vec(),
            ))
            .unwrap();
        harness.events.send(ChannelEvent::EndOfData).unwrap();
        harness.events.send(ChannelEvent::Exited(1)).unwrap();
        harness.events.send(ChannelEvent::Ended).unwrap();

        let deadline = Instant::now() + PATIENCE;
        let error = harness
            .with_reader_within(PATIENCE, move |reader| {
                reader.set_absolute_deadline(Some(deadline));
                read_answer(reader, 1024)
            })
            .unwrap_err();
        assert_eq!(error.code(), "hmux_gateway_command_failed");
        let message = error.to_string();
        assert!(message.contains("exited with status 1"), "{message}");
        assert!(
            message.contains("cannot find the path specified"),
            "{message}"
        );
    }

    /// A gateway that exits 0 without a document is a different, quieter
    /// failure; the caller's own "returned no <receipt>" wording stays right.
    #[test]
    fn a_clean_silent_exit_is_reported_as_no_answer() {
        let harness = Harness::new(vec![]);
        harness.events.send(ChannelEvent::EndOfData).unwrap();
        harness.events.send(ChannelEvent::Exited(0)).unwrap();
        harness.events.send(ChannelEvent::Ended).unwrap();

        let deadline = Instant::now() + PATIENCE;
        let answer = harness
            .with_reader_within(PATIENCE, move |reader| {
                reader.set_absolute_deadline(Some(deadline));
                read_answer(reader, 1024)
            })
            .unwrap();
        assert!(answer.is_none());
    }

    /// The answer itself comes back as soon as it is complete. Waiting for
    /// the channel to finish is only for the case where nothing came.
    #[test]
    fn an_answer_is_returned_before_the_channel_finishes() {
        let harness = Harness::new(vec![]);
        harness.send(&document("session-1"));

        let deadline = Instant::now() + PATIENCE;
        let payload = harness
            .with_reader_within(PATIENCE, move |reader| {
                reader.set_absolute_deadline(Some(deadline));
                read_answer(reader, 1024 * 1024)
            })
            .unwrap()
            .unwrap();
        assert_eq!(payload, document("session-1")[LENGTH_PREFIX_BYTES..]);
    }

    /// The listing is the first request a newly added host receives, so it
    /// must name a command that never ran under the same code as every other
    /// request, not as an invalid catalog.
    #[test]
    fn a_listing_whose_command_failed_reports_the_reason_under_the_same_code() {
        let harness = Harness::new(vec![]);
        harness
            .events
            .send(ChannelEvent::Diagnostic(
                b"hmux: command not found\n".to_vec(),
            ))
            .unwrap();
        harness.events.send(ChannelEvent::EndOfData).unwrap();
        harness.events.send(ChannelEvent::Exited(127)).unwrap();
        harness.events.send(ChannelEvent::Ended).unwrap();

        let deadline = Instant::now() + PATIENCE;
        let error = harness
            .with_reader_within(PATIENCE, move |reader| {
                reader.set_absolute_deadline(Some(deadline));
                read_catalog(reader, 1)
            })
            .unwrap_err();
        assert_eq!(error.code(), "hmux_gateway_command_failed");
        let message = error.to_string();
        assert!(message.contains("exited with status 127"), "{message}");
        assert!(message.contains("command not found"), "{message}");
    }

    /// A gateway that delivered its catalog and exited 0 delivered its
    /// catalog. Stderr noise from a login profile is not a reason to lose it.
    #[test]
    fn a_listing_that_exited_cleanly_survives_stderr_noise() {
        let harness = Harness::new(vec![]);
        harness.send(&document("session-1"));
        harness
            .events
            .send(ChannelEvent::Diagnostic(
                b"bash: warning: setlocale\n".to_vec(),
            ))
            .unwrap();
        harness.events.send(ChannelEvent::EndOfData).unwrap();
        harness.events.send(ChannelEvent::Exited(0)).unwrap();
        harness.events.send(ChannelEvent::Ended).unwrap();

        let deadline = Instant::now() + PATIENCE;
        let sessions = harness
            .with_reader_within(PATIENCE, move |reader| {
                reader.set_absolute_deadline(Some(deadline));
                read_catalog(reader, 1)
            })
            .unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "session-1");
    }
}
