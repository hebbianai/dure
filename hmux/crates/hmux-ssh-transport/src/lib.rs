//! Hmux frames over an SSH exec channel.
//!
//! This is the transport for a client that is **not on the session's machine**:
//! a phone attaching to an agent running on a box, while the laptop that
//! started it is closed. Everything a local Unix socket bundles into its type —
//! a manifest read under `path_security`, a capability token readable only by
//! this euid, a kernel credential check, a shared process table — is absent
//! here, so this crate produces a transport whose attestation yields **no
//! colocation witness**. Operations that signal pids or scan `/proc` take that
//! witness by argument, and therefore cannot compile against this transport.
//!
//! The far end is `hmux mobile-gateway`, a first-class Hmux client running on
//! the session's machine as the session's user. It performs the filesystem
//! provenance checks locally and dials the local socket itself; this crate
//! moves frames, and never carries the capability token over the network.
//!
//! ## What was hard
//!
//! - **The exec channel has no PTY.** That is a precondition, not an
//!   optimization: a PTY would insert a line discipline that rewrites `\n`
//!   inside frame payloads and interprets control bytes as signals.
//! - **Waking a blocked reader.** A socket gets this from `shutdown`; an SSH
//!   channel has nothing equivalent, so the wake path is explicit
//!   (`inbound.rs`).
//! - **All-or-nothing writes.** The queue holds whole frames and the pump
//!   counts what the channel accepted, so a failure can be classified as "the
//!   peer's stream is still frame-aligned" or "it is not" (`outbound.rs`).
//! - **Not deadlocking.** Both directions can stall at once — a 700 KiB
//!   snapshot arriving during a large paste — so the two directions are
//!   independent futures rather than steps in one loop (`pump.rs`).
//!
//! ## Why russh
//!
//! ssh2 is a C library, built with vendored OpenSSL on the desktop, which is
//! not something a phone build can carry; and it serializes every channel on
//! one session-wide lock, so a blocking read starves every writer. russh is
//! not quite the pure-Rust library it is often called — it refuses to build
//! without `ring` or `aws-lc-rs`, both of which compile native code — but it
//! builds with an ordinary cross toolchain, which is what actually matters.
//! `aarch64-apple-ios` and `aarch64-linux-android` are both verified.

mod attach;
mod catalog;
mod channel;
mod dialer;
mod error;
mod exec;
#[cfg(test)]
mod harness;
mod host_key;
mod inbound;
mod managed_broker;
mod outbound;
mod pump;
mod session;
mod shared;
mod standalone_create;
mod transport;

pub use attach::{
    AttachError, OutputBudget, OutputStop, RelayReceipt, RemoteAttach,
    attach_agent_prompt_over_ssh, attach_controller_over_ssh, attach_observer_over_ssh,
    attach_over_ssh, attach_terminal_surface_over_ssh, depart_gracefully_over_ssh,
    describe_attestation, relay_output,
};
pub use catalog::session_resolution;
pub use catalog::{
    CatalogError, FileDiffBody, FileDiffDocument, MAX_REMOTE_SESSION_INPUT_BYTES,
    RemoteCatalogSession, RemoteCommandIntercept, RemoteHostLiveness, RemoteProtocolVersion,
    RemoteSessionClass, RemoteSessionInputReceipt, RemoteSessionInputRequest,
    RemoteSessionLifecycle, RemoteStandaloneCreateReceipt, RemoteStandaloneCreateRequest,
    RemoteUnpresentedCreationAbandonReceipt, RemoteUnpresentedCreationAbandonRequest,
    RemoteVersionRange, SourceControlBody, SourceControlCommit, SourceControlCommits,
    SourceControlDocument, SourceControlFile, SourceControlFileDiffRequest, SourceControlReview,
    SourceControlReviewOpen, SourceControlSnapshot, SourceControlStatusRequest, SourceControlWant,
    abandon_unpresented_creation_over_ssh, create_standalone_over_ssh, file_diff_over_ssh,
    list_sessions_over_ssh, list_sessions_with_facts_over_ssh, source_control_status_over_ssh,
    write_session_input_over_ssh,
};
pub use channel::{ChannelEvent, ExecChannelReader, ExecChannelWriter};
pub use dialer::{SshExecDialer, SshTransportHalves};
pub use error::SshTransportError;
pub use exec::{SshExecOutput, execute_bounded_over_ssh};
pub use host_key::{ObservedHostKey, observe_server_host_key};
pub use inbound::ChannelCompletion;
pub use managed_broker::{
    RemoteManagedCreateAdvanceResolution, RemoteManagedCreateChainStopError,
    RemoteManagedCreateError, RemoteManagedCreateReconcileError, RemoteManagedCreateResolution,
    RemoteManagedCreateResolutionError, RemoteManagedRehostError, RemoteManagedStopError,
    create_managed_or_reconcile_and_advance_over_ssh, create_managed_or_reconcile_over_ssh,
    create_managed_over_ssh, reconcile_managed_create_over_ssh, reconcile_managed_rehost_over_ssh,
    reconcile_managed_stop_over_ssh, rehost_managed_over_ssh, stop_managed_create_chain_over_ssh,
    stop_managed_create_chain_v2_over_ssh, stop_managed_over_ssh,
};
pub use session::{
    DEFAULT_GATEWAY_COMMAND, HostKeyPolicy, SshAuthentication, SshEndpoint, SshExecConfig,
    openssh_host_key_algorithms,
};
pub use standalone_create::{RetainedRemoteStandaloneCreation, create_standalone_durably_over_ssh};
pub use transport::{SshFrameReader, SshFrameWriter, SshInterrupt};

// Re-exported so a caller of this crate can name everything an attach needs
// without also depending on `hmux-client` and `hmux-host` directly. The seam is
// meant to be usable from one dependency edge; two would make the example and
// any future mobile client carry the whole tree's version skew.
pub use hmux_client::{
    AttachReplay, AttachedControllerAttachment, AttachedObserverAttachment,
    AttachedSessionController, AttachedSessionObserver, ClientError, ControllerEvent,
    ControllerInterrupt, ControllerMutationHandle, LocalAttachRole, LocalConnection, ObserverEvent,
    ObserverInterrupt, ObserverMutationHandle, PeerAttestation, SessionFence,
    SessionRetirementPolicy, SessionRetirementReceipt, SessionRetirementReceiptReason,
    SessionRetirementReceiptState, TerminalAgentPromptError, TerminalAgentPromptReceipt,
    TerminalIntentReceipt, TerminalSurfaceAccess, TerminalSurfaceAttachment, TerminalSurfaceEvent,
    TerminalSurfaceFrame,
};
pub use hmux_session_protocol::ReconnectCursor;
