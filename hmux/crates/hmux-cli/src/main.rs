mod attach_recovery;
mod command_bridge_executable;
#[cfg(unix)]
mod doctor;
mod exact_probe_batch;
mod managed_attach;
mod managed_rehost_execution;
mod managed_rehost_identity;
mod managed_rehost_observation;
mod mobile_gateway;
mod output;
mod pairing;
mod remote_managed_attach;
mod resurrection;
mod runtime_info;
mod runtime_status;
mod screen_read;
mod semantic_input;
mod semantic_keys;
mod source_control;
#[cfg(unix)]
mod standalone_create_operation;
mod standalone_upgrade;
use runtime_info::runtime_build_id;
mod terminal_attach_ui;

macro_rules! cli_print {
    ($($argument:tt)*) => {
        crate::output::write(format_args!($($argument)*))
    };
}

macro_rules! cli_println {
    ($($argument:tt)*) => {
        crate::output::writeln(format_args!($($argument)*))
    };
}

use base64::Engine as _;
use clap::{Args, Parser, Subcommand};
#[cfg(unix)]
use doctor::{DoctorArgs, LocalDoctorReport, session_summary as doctor_session_summary};
use hmux_client::{
    CatalogCensusError, CatalogCensusWorker, ClientError, ExactDiscoveryWorker,
    ExitedSessionRetirementCandidates, ExitedSessionRetirementCursor,
    ExitedSessionRetirementGeneration, ExitedSessionRetirementMode, ExitedSessionRetirementOutcome,
    ExitedSessionRetirementReason, ExitedSessionRetirementReport, ExitedSessionRetirementTarget,
    HMUX_ENV, HMUX_SESSION_ID_ENV, HMUX_WORKSPACE_ID_ENV, LivenessState, LocalAttachRole,
    LocalConnection, LocalSession, LocalSessionCatalog, LocalSessionObserver,
    MAX_EXITED_SESSION_RETIREMENT_TARGETS, ManagedCreateRequest, ManagedSessionCreator,
    ManagedSessionStopper, ManagedStopRequest, ObserverAttachOptions, PermissionMode,
    Recoverability, SESSION_CATALOG_QUERY_SCHEMA_VERSION, SESSION_RETIREMENT_CAPABILITY,
    SessionCatalogQuery, SessionClass, SessionDescriptor, SessionEffectiveLifecycle, SessionHealth,
    SessionInspection, SessionLifecycle, SessionLiveness, SessionLivenessInput, SessionProbeStatus,
    SessionRetirementPolicy, SessionRetirementReceipt, SessionRetirementReceiptReason,
    SessionRetirementReceiptState, SessionSelector, StandaloneResurrectionReplayPolicy,
    StandaloneSessionCreator, TerminalEnvironment, inspect_local_session, inspect_local_sessions,
    inspect_local_sessions_exact_isolated, list_local_sessions_isolated, probe_local_session_exact,
    project_session_liveness, query_local_sessions_isolated, recoverability_name,
    resolve_local_session_from_complete_census, resolve_local_session_id_isolated,
    resolve_local_session_isolated, resolve_local_session_name_isolated, serve_catalog_census,
    serve_exact_discovery_lookup,
};
#[cfg(unix)]
use hmux_client::{
    LocalProcessGenerationStatus, LocalStateGcPolicy, LocalStateGcReport, ProcessDescriptor,
    collect_local_state, probe_local_process_generation,
};
use hmux_client::{MANAGED_REHOST_SCHEMA, MANAGED_REHOST_SCHEMA_VERSION};
use hmux_host::local_discovery::workspace_id_for_path;
#[cfg(unix)]
use hmux_host::local_discovery::{DiscoveryGcMode, DiscoveryGcSelection};
use hmux_host::local_protocol::{FrameBody, SessionFence};
use managed_rehost_execution::{ManagedRehostArgs, ManagedRehostOperationArgs};
use managed_rehost_observation::ManagedRehostResolveArgs;
use screen_read::ReadArgs;
use semantic_input::CommandInputArgs;
use std::collections::BTreeMap;
use std::fmt;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

#[cfg(unix)]
const CLI_CAPABILITIES: &[&str] = &[
    "pairing_v1",
    "pairing_revoke_inventory_v1",
    "managed_interactive_attach_v1",
    "ssh_managed_interactive_attach_v1",
    "managed_screen_read_v1",
    "bounded_screen_read_v1",
    "session_liveness_v1",
    "bounded_discovery_census_v1",
    "bounded_session_catalog_query_v1",
    "bounded_session_catalog_pagination_v1",
    "local_state_gc_v1",
    "local_state_gc_all_eligible_v1",
    "local_state_doctor_v1",
    "generation_fenced_kill_v1",
    "managed_generation_fenced_kill_v1",
    "managed_rehost_exact_fence_v1",
    "managed_rehost_resolution_v1",
    managed_rehost_observation::CAPABILITY,
    managed_rehost_execution::RECONCILE_CAPABILITY,
    managed_rehost_execution::START_CAPABILITY,
    managed_rehost_identity::CAPABILITY,
    "semantic_command_input_v1",
    semantic_keys::CAPABILITY,
    "session_inspection_v1",
    hmux_client::SESSION_FILE_ROUTE_CAPABILITY,
    "session_probe_status_v1",
    "exact_session_probe_batch_v1",
    "session_retirement_v1",
    "exited_session_cleanup_v1",
    "process_generation_probe_v1",
    standalone_create_operation::CAPABILITY,
    standalone_create_operation::RECONCILE_CAPABILITY,
    standalone_create_operation::RETIRE_CAPABILITY,
    standalone_create_operation::ACKNOWLEDGE_CAPABILITY,
    runtime_status::RUNTIME_STATUS_CAPABILITY,
];
#[cfg(not(unix))]
const CLI_CAPABILITIES: &[&str] = &[
    "pairing_v1",
    "pairing_revoke_inventory_v1",
    "managed_screen_read_v1",
    "bounded_screen_read_v1",
    "bounded_discovery_census_v1",
    "bounded_session_catalog_query_v1",
    "bounded_session_catalog_pagination_v1",
    "generation_fenced_kill_v1",
    "managed_generation_fenced_kill_v1",
    "managed_rehost_exact_fence_v1",
    "managed_rehost_resolution_v1",
    managed_rehost_observation::CAPABILITY,
    managed_rehost_execution::RECONCILE_CAPABILITY,
    managed_rehost_execution::START_CAPABILITY,
    managed_rehost_identity::CAPABILITY,
    "semantic_command_input_v1",
    semantic_keys::CAPABILITY,
    "session_liveness_v1",
    "session_inspection_v1",
    "session_probe_status_v1",
    "exact_session_probe_batch_v1",
    "session_retirement_v1",
    runtime_status::RUNTIME_STATUS_CAPABILITY,
];

const SESSION_INSPECTION_WORKERS: usize = 8;
const CATALOG_CENSUS_BUDGET: Duration = Duration::from_millis(1_500);
const CLI_BUILD_ID: &str = env!("HMUX_BUILD_ID");
const BUILD_PROVENANCE_TEXT: &str = concat!(
    "{\"schemaVersion\":1,\"product\":\"hmux\",\"binary\":\"hmux\",\"buildId\":\"",
    env!("HMUX_BUILD_ID"),
    "\",\"sourceCommit\":\"",
    env!("HMUX_SOURCE_COMMIT"),
    "\",\"targetTriple\":\"",
    env!("HMUX_TARGET_TRIPLE"),
    "\"}"
);
#[used]
#[cfg_attr(target_os = "linux", unsafe(link_section = ".hmux.build"))]
static BUILD_PROVENANCE: [u8; BUILD_PROVENANCE_TEXT.len()] =
    string_bytes::<{ BUILD_PROVENANCE_TEXT.len() }>(BUILD_PROVENANCE_TEXT);

const fn string_bytes<const LENGTH: usize>(value: &str) -> [u8; LENGTH] {
    let source = value.as_bytes();
    let mut result = [0_u8; LENGTH];
    let mut index = 0;
    while index < LENGTH {
        result[index] = source[index];
        index += 1;
    }
    result
}

#[derive(Debug, Parser)]
#[command(
    name = "hmux",
    version,
    about = "Attach to and inspect Hmux sessions",
    long_about = None
)]
struct Cli {
    /// Read manifests from this discovery root.
    #[arg(long, global = true, value_name = "PATH")]
    discovery_root: Option<PathBuf>,

    /// Emit stable machine-readable JSON.
    #[arg(long, global = true)]
    json: bool,

    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Print stable CLI capability identifiers for automation.
    Capabilities,

    /// Inspect the app-independent terminal backend runtime.
    Runtime {
        #[command(subcommand)]
        command: RuntimeCommand,
    },

    /// Start a detached standalone shell or command.
    New(NewArgs),

    /// List locally discoverable Hmux sessions.
    #[command(alias = "list")]
    Ls(ListArgs),

    /// Preview or apply bounded cleanup of retired or abandoned local state.
    #[cfg(unix)]
    Gc(GcArgs),

    /// Inspect local session liveness and cleanup candidates without mutation.
    #[cfg(unix)]
    Doctor(DoctorArgs),

    /// Inspect one exact local OS process generation without signaling it.
    #[cfg(unix)]
    Process {
        #[command(subcommand)]
        command: ProcessInspectionCommand,
    },

    /// Attach to a standalone session.
    #[command(aliases = ["a", "at", "attach-session"])]
    Attach(AttachArgs),

    /// Attach to one exact managed session through the runtime authorization broker.
    #[command(name = "managed-attach")]
    ManagedAttach(ManagedAttachArgs),

    /// Attach to one exact managed session through a no-PTY SSH frame relay.
    #[command(name = "remote-managed-attach")]
    RemoteManagedAttach(RemoteManagedAttachArgs),

    /// Print the current canonical screen.
    Screen(ScreenArgs),

    /// Send keys without opening an interactive client.
    #[command(name = "send-keys", alias = "send")]
    SendKeys(SendKeysArgs),

    /// Send semantic command text and an optional submit key.
    #[command(name = "command-input")]
    AutomationInput(CommandInputArgs),

    /// Apply one exact terminal geometry without opening an interactive client.
    Resize(ResizeArgs),

    /// Print recent visible terminal lines.
    Read(ReadArgs),

    /// Terminate one exact local session's provider.
    Kill(KillArgs),

    /// Rehost one exact managed provider without depending on a Dure app process.
    #[command(name = "managed-rehost")]
    ManagedRehost(ManagedRehostArgs),

    /// Continue an existing journaled rehost; never admit a fresh operation.
    #[command(name = "managed-rehost-reconcile")]
    ManagedRehostReconcile(ManagedRehostOperationArgs),

    /// Start or replay a same-conversation rehost of one exact original source.
    #[command(name = "managed-rehost-start")]
    ManagedRehostStart(ManagedRehostOperationArgs),

    /// Resolve a retired managed source to its latest durable generation.
    #[command(name = "managed-rehost-resolve")]
    ManagedRehostResolve(ManagedRehostResolveArgs),

    /// Recreate a saved standalone session after reboot or exit.
    Restore(RestoreArgs),

    /// Restart a healthy standalone session on another Hmux runtime build.
    Upgrade(UpgradeArgs),

    /// Show the Hmux session hosting the current shell.
    Current,

    /// Bridge one local session onto stdio for an SSH-invoked remote client.
    ///
    /// Intended as an `authorized_keys` forced command, which is why it takes no
    /// required arguments: sshd replaces the client's argv with the pinned line,
    /// so anything a phone must be able to ask for travels on the stream.
    /// `command="\"$HOME/.local/bin/hmux\" mobile-gateway",restrict` is the shape
    /// `hmux pair` installs; adding `--session <id>` narrows the same key to one
    /// session.
    ///
    /// The path is absolute because the forced command is not always what runs.
    /// A host that authenticates the connection some other way — Tailscale SSH
    /// serves the session itself and never opens `authorized_keys` — executes
    /// the client's own string instead, and `~/.local/bin` is not on a
    /// non-interactive `PATH`. Both sides therefore send the same absolute
    /// invocation; see `hmux_client::gateway_invocation`.
    MobileGateway(MobileGatewayArgs),

    /// Launch a provider in a managed Host from a Dure-scoped command bridge.
    #[command(name = "command-bridge", hide = true)]
    ProviderBridge(CommandBridgeArgs),

    /// Resolve one exact discovery manifest for a bounded parent process.
    #[command(name = "internal-exact-discovery-lookup", hide = true)]
    ExactDiscoveryLookup,

    /// Enumerate local discovery for a bounded parent process.
    #[command(name = "internal-discovery-census", hide = true)]
    DiscoveryCensus,

    /// Create or replay one journaled standalone session operation.
    #[cfg(unix)]
    #[command(name = "internal-standalone-create-operation", hide = true)]
    StandaloneCreateOperation,

    /// Pair a phone with this laptop and every SSH host it has configured.
    ///
    /// The laptop is on the path once, at the desk. Afterwards the phone
    /// reaches each server directly and the laptop can be closed.
    Pair {
        #[command(subcommand)]
        command: PairCommand,
    },

    /// Inspect Hmux sessions.
    Session {
        #[command(subcommand)]
        command: SessionCommand,
    },
}

#[derive(Debug, Subcommand)]
enum PairCommand {
    /// Show a pairing QR and accept one proven request.
    Start(pairing::PairStartArgs),

    /// List paired devices and where their keys were installed.
    List,

    /// Pair with no network between the phone and this laptop.
    ///
    /// `start` needs one round trip: the phone dials this laptop to prove a
    /// token. That works on one wifi and nowhere else. This generates the key
    /// pair here, installs the public half itself, and seals the private half
    /// into the QR under a short code printed beside it.
    Offline(pairing::offline::PairOfflineArgs),

    /// Remove one paired device's key from every host it reached.
    Revoke(pairing::PairRevokeArgs),

    /// Apply one pairing entry to this account's authorized_keys.
    ///
    /// The far side of the laptop's ssh hop, and hidden because it is not an
    /// operator-facing command: the laptop pipes it a request over ssh so the
    /// append rules have one implementation instead of a Rust one and a shell
    /// one. Runs as the invoking account and refuses anything that is not a
    /// restricted forced-command entry.
    #[command(name = "apply-authorized-key", hide = true)]
    ApplyAuthorizedKey,

    /// Remove one pairing entry from this account's authorized_keys.
    #[command(name = "remove-authorized-key", hide = true)]
    RemoveAuthorizedKey,
}

#[derive(Args, Debug)]
struct NewArgs {
    /// Human-readable name used by attach, read, and send-keys.
    #[arg(long)]
    name: Option<String>,

    /// Attach immediately after the session is ready.
    #[arg(long)]
    foreground: bool,

    /// Runtime executable; defaults to HMUX_RUNTIME or a bundled/sibling binary.
    #[arg(long, value_name = "PATH")]
    runtime: Option<PathBuf>,

    /// Set an explicit terminal capability variable for this session.
    #[arg(long = "env", value_name = "NAME=VALUE")]
    environment: Vec<String>,

    /// Explicitly remove a terminal capability variable for this session.
    #[arg(long = "unset-env", value_name = "NAME")]
    unset_environment: Vec<String>,

    /// Command to run; defaults to $SHELL, then /bin/sh.
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    command: Vec<String>,
}

#[derive(Args, Debug)]
#[cfg(unix)]
struct GcArgs {
    /// Apply the reported cleanup. Without this flag, no session state is removed.
    #[arg(long)]
    apply: bool,

    /// Select every otherwise-eligible session instead of only state required by retention budgets.
    #[arg(long)]
    all_eligible: bool,
}

#[derive(Debug, Subcommand)]
#[cfg(unix)]
enum ProcessInspectionCommand {
    /// Report whether the exact pid + start-marker generation is still live.
    Probe {
        process_id: u32,
        start_marker: String,
    },
}

#[derive(Debug, Subcommand)]
enum SessionCommand {
    /// Route staged files into the exact session's foreground SSH filesystem.
    #[cfg(unix)]
    RouteFiles {
        session_id: String,
        #[arg(long)]
        workspace: String,
        #[arg(long)]
        terminal_epoch: String,
        #[arg(long)]
        paths_json: String,
    },
    /// List locally discoverable Hmux sessions.
    #[command(alias = "ls")]
    List(ListArgs),

    /// Show one exact Hmux session descriptor.
    Show {
        session_id: String,

        /// Disambiguate the session by workspace id.
        #[arg(long)]
        workspace: Option<String>,
    },

    /// Perform one bounded observer handshake without opening a terminal.
    Probe {
        session_id: String,

        /// Disambiguate the session by workspace id.
        #[arg(long)]
        workspace: Option<String>,
    },

    /// Probe a bounded JSON batch of exact workspace/session identities.
    ///
    /// This command never enumerates the local catalog, so unrelated discovery
    /// entries cannot delay a requested target. Each target receives an
    /// alive/dead/unknown receipt under one shared deadline.
    ProbeBatch(exact_probe_batch::SessionProbeBatchArgs),

    /// Read one bounded canonical snapshot without opening a terminal.
    Snapshot {
        session_id: String,

        /// Disambiguate the session by workspace id.
        #[arg(long)]
        workspace: Option<String>,
    },

    /// Preview or apply generation-fenced archival of exited sessions.
    CleanupExited(CleanupExitedArgs),

    /// Inspect or exercise one standalone session's retirement contract.
    Retirement {
        #[command(subcommand)]
        command: SessionRetirementCommand,
    },
}

#[derive(Debug, Subcommand)]
enum RuntimeCommand {
    /// Emit a bounded aggregate from Hmux discovery and observer probes.
    Status(RuntimeStatusArgs),
}

#[derive(Args, Debug)]
struct RuntimeStatusArgs {
    /// Override the census-sized wall-clock budget shared by all Host probes.
    #[arg(long, value_parser = clap::value_parser!(u64).range(0..=10_000))]
    probe_budget_ms: Option<u64>,
}

#[derive(Args, Debug)]
struct CleanupExitedArgs {
    /// One exact session id. Omit to inspect every exited session.
    session: Option<String>,

    /// Exact workspace for the positional session id; generation JSON can supply it.
    #[arg(long, requires = "session")]
    workspace: Option<String>,

    /// Refuse if the current terminal epoch differs from this observed value.
    #[arg(long, requires = "session")]
    expected_terminal_epoch: Option<String>,

    /// Complete generation object returned by JSON preview. Repeat for a batch apply.
    #[arg(long, value_name = "JSON")]
    expected_generation_json: Vec<String>,

    /// Versioned cursor returned by a truncated JSON preview.
    #[arg(
        long,
        value_name = "JSON",
        conflicts_with_all = ["session", "expected_generation_json"]
    )]
    after_cursor_json: Option<String>,

    /// Archive eligible active pointers. Without this flag the command is read-only.
    #[arg(long)]
    apply: bool,
}

#[derive(Debug, Subcommand)]
enum SessionRetirementCommand {
    /// Show the durable policy projected by the current Host manifest.
    Show(RetirementTargetArgs),

    /// Opt into retirement after the last explicit graceful departure.
    Set {
        #[command(flatten)]
        target: RetirementTargetArgs,

        /// Grace period after the last explicit graceful departure.
        #[arg(long, value_parser = clap::value_parser!(u64).range(1_000..=300_000))]
        grace_period_ms: u64,
    },

    /// Return to the compatibility default: retain until an explicit stop.
    Clear(RetirementTargetArgs),

    /// Preview eligibility, or apply it only with an explicit flag.
    Sweep(RetirementSweepArgs),
}

#[derive(Args, Debug)]
struct RetirementTargetArgs {
    /// Standalone session name, exact id, or unique printed id prefix.
    session: String,

    /// Disambiguate an exact session id by workspace id.
    #[arg(long)]
    workspace: Option<String>,
}

#[derive(Args, Debug)]
struct RetirementSweepArgs {
    /// One standalone session name, exact id, or unique printed id prefix.
    /// Omit to evaluate every Ready standalone session in this discovery root.
    session: Option<String>,

    /// Disambiguate an exact session id by workspace id.
    #[arg(long, requires = "session")]
    workspace: Option<String>,

    /// Apply eligible retirements. Without this flag every evaluation is read-only.
    #[arg(long)]
    apply: bool,
}

#[derive(Args, Debug)]
struct AttachArgs {
    /// Standalone session name, exact id, or unique printed id prefix.
    #[arg(conflicts_with_all = ["target", "name"])]
    session: Option<String>,

    /// tmux-compatible target spelling.
    #[arg(short = 't', long = "target", conflicts_with_all = ["session", "name"])]
    target: Option<String>,

    /// Resolve one exact standalone session name.
    #[arg(long, conflicts_with_all = ["session", "target"])]
    name: Option<String>,

    /// Attach as a read-only observer.
    #[arg(short = 'r', long = "read-only", alias = "observer")]
    read_only: bool,
}

#[derive(Args, Debug)]
struct ManagedAttachArgs {
    /// Exact managed session id.
    session: String,

    /// Exact workspace id.
    #[arg(long)]
    workspace: String,
}

#[derive(Args, Debug)]
struct RemoteManagedAttachArgs {
    /// Exact managed session id.
    session: String,

    /// Exact workspace id.
    #[arg(long)]
    workspace: String,

    #[arg(long)]
    host: String,

    #[arg(long)]
    port: u16,

    #[arg(long)]
    user: String,

    /// Bound only SSH establishment; the attached terminal remains long-lived.
    #[arg(long, value_parser = clap::value_parser!(u64).range(1..=45_000))]
    connect_timeout_ms: u64,

    #[arg(
        long,
        conflicts_with = "ssh_agent",
        required_unless_present = "ssh_agent"
    )]
    identity_file: Option<PathBuf>,

    /// Authenticate with the agent selected by SSH_AUTH_SOCK.
    #[arg(
        long,
        conflicts_with = "identity_file",
        required_unless_present = "identity_file"
    )]
    ssh_agent: bool,

    #[arg(long)]
    known_hosts_file: PathBuf,

    /// Complete fence returned by the selected backend's exact session query.
    #[arg(long)]
    expected_fence_json: String,
}

impl AttachArgs {
    fn identifier(&self) -> Result<&str, CliError> {
        self.session
            .as_deref()
            .or(self.target.as_deref())
            .ok_or_else(|| CliError("attach requires a session, --target, or --name".into()))
    }
}

#[derive(Args, Debug)]
struct ScreenArgs {
    /// Standalone session name, exact id, or unique printed id prefix.
    session: String,

    /// Emit snapshot metadata and base64 repaint bytes.
    #[arg(long, value_enum, default_value_t = ScreenFormat::Ansi)]
    format: ScreenFormat,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, clap::ValueEnum)]
enum ScreenFormat {
    Ansi,
    Json,
}

#[derive(Args, Debug)]
struct SendKeysArgs {
    /// Session name, exact id, or unique printed id prefix.
    #[arg(short = 't', long = "target")]
    session: String,

    /// Exact workspace id when the same session id exists in several workspaces.
    #[arg(long)]
    workspace: Option<String>,

    /// Refuse unless the resolved managed session still has this complete generation.
    #[arg(long, value_name = "JSON")]
    expected_fence_json: Option<String>,

    /// Treat all arguments as literal text.
    #[arg(short = 'l', long)]
    literal: bool,

    /// Text and key names, concatenated in order.
    #[arg(required = true, trailing_var_arg = true, allow_hyphen_values = true)]
    keys: Vec<String>,
}

#[derive(Args, Debug)]
struct ResizeArgs {
    /// Session name, exact id, or unique printed id prefix.
    #[arg(short = 't', long = "target")]
    session: String,

    /// Exact workspace id when the same session id exists in several workspaces.
    #[arg(long)]
    workspace: Option<String>,

    /// Refuse unless this is the current generation or its exact durable rehost source.
    #[arg(long, value_name = "JSON")]
    expected_fence_json: Option<String>,

    /// Terminal columns to apply.
    #[arg(long, value_parser = clap::value_parser!(u16).range(1..=1024))]
    columns: u16,

    /// Terminal rows to apply.
    #[arg(long, value_parser = clap::value_parser!(u16).range(1..=512))]
    rows: u16,
}

#[derive(Args, Debug)]
struct KillArgs {
    /// Session name, exact id, or unique printed id prefix.
    session: String,

    /// Exact workspace id when the same session id exists in several workspaces.
    #[arg(long)]
    workspace: Option<String>,

    /// Time to wait for the Host to publish the exited lifecycle.
    #[arg(long, default_value_t = 2000, value_parser = clap::value_parser!(u64).range(100..=30_000))]
    timeout_ms: u64,

    /// Refuse unless the resolved session still has this complete generation.
    #[arg(long, value_name = "JSON")]
    expected_fence_json: Option<String>,

    /// Runtime executable used to authorize a managed provider stop.
    #[arg(long, value_name = "PATH")]
    runtime: Option<PathBuf>,
}

#[derive(Args, Debug)]
struct RestoreArgs {
    /// Saved standalone session name.
    session: String,

    /// Confirm re-running a recipe that used an explicit command.
    #[arg(long)]
    run: bool,

    /// Attach immediately after the replacement session is ready.
    #[arg(long)]
    foreground: bool,

    /// Runtime executable; defaults to HMUX_RUNTIME or a bundled/sibling binary.
    #[arg(long, value_name = "PATH")]
    runtime: Option<PathBuf>,
}

#[derive(Args, Debug)]
struct UpgradeArgs {
    /// Standalone session name, exact id, or unique printed id prefix.
    session: String,

    /// Resume this exact saved upgrade, including after its source has stopped.
    #[arg(long)]
    operation_id: Option<String>,

    /// Confirm terminating the healthy source before recreating it.
    #[arg(long)]
    confirm_restart: bool,

    /// Attach immediately after the replacement session is ready.
    #[arg(long)]
    foreground: bool,

    /// Runtime executable; defaults to HMUX_RUNTIME or a bundled/sibling binary.
    #[arg(long, value_name = "PATH")]
    runtime: Option<PathBuf>,

    /// Time to wait for the source Host to retire.
    #[arg(long, default_value_t = 3000, value_parser = clap::value_parser!(u64).range(100..=30_000))]
    timeout_ms: u64,
}

#[derive(Args, Debug)]
struct MobileGatewayArgs {
    /// Narrow this gateway to one session: name, exact id, or unique prefix.
    ///
    /// **Optional, and a constraint rather than the selector.** When present,
    /// this invocation serves that session and refuses a relayed `Hello` naming
    /// any other — the escape hatch for an operator who wants a key pinned to
    /// exactly one session. When absent, the session comes from the relayed
    /// `Hello`'s own `expected_fence`, which is still cross-checked
    /// component-by-component against the fence read off this box's manifest
    /// before any attach.
    ///
    /// Absent therefore means the key reaches every session this account owns
    /// here, including ones created after pairing. That widening was chosen
    /// deliberately by the project owner: requiring `--session` made the one key
    /// `hmux pair` installs unusable, because a forced command replaces the
    /// client's argv, so the phone could supply neither `--session` nor
    /// `--list` and every connection exited 2. Pinning two keys instead does not
    /// survive a Host replacement, which moves the session id. See
    /// `mobile_gateway`'s module header for what still bounds such a key.
    #[arg(long, value_name = "SESSION")]
    session: Option<String>,

    /// Strongest authority a relayed client may reach through this invocation.
    #[arg(long, value_enum, default_value_t = mobile_gateway::GatewayRole::Observer)]
    role: mobile_gateway::GatewayRole,

    /// Let a relayed client start a new session on this box.
    ///
    /// Off by default, and the default is the security decision: the key
    /// `hmux pair` installs lives on a phone, and attaching to what this
    /// account already runs is a smaller authority than starting something new.
    ///
    /// An operator who wants a phone to start work while the laptop is off adds
    /// this to the `authorized_keys` line — the one place that already carries
    /// this key's authority, per box, and still revocable in one action with
    /// `hmux pair revoke`. `restrict` and the forced command are untouched: the
    /// key still runs this binary and nothing else.
    ///
    /// The line is written by pairing, so the opt-in is spelled there — once
    /// for every server that pairing touches, not per box:
    ///
    /// ```text
    /// hmux pair --writable --allow-create
    /// ```
    #[arg(long)]
    allow_create: bool,

    /// Exact workspace id when the same session id exists in several workspaces.
    #[arg(long)]
    workspace: Option<String>,

    /// Emit the session catalog as frames instead of attaching, then exit.
    ///
    /// A hand-invocation convenience, and no longer the only route: a forced
    /// command cannot be talked into this flag, because sshd runs the pinned
    /// line verbatim and moves the client's request to `SSH_ORIGINAL_COMMAND`,
    /// which this binary does not read. A relayed client asks for the same
    /// listing by sending a request document over the stream instead — see
    /// `mobile_gateway::list_stdio`. Both routes run the same code with the same
    /// scope, so `--session` narrows either one.
    ///
    /// `--role` is ignored here: a listing confers no session authority.
    #[arg(long)]
    list: bool,
}

#[derive(Args, Debug)]
struct CommandBridgeArgs {
    /// Private directory containing the intercept script currently executing.
    #[arg(long, value_name = "PATH")]
    bridge_dir: PathBuf,

    /// Exact nonce injected into the source standalone session.
    #[arg(long)]
    bridge_nonce: String,

    /// Provider-neutral runtime identity selected by the Dure adapter.
    #[arg(long)]
    provider_id: String,

    /// Command name to resolve after removing the bridge directory from PATH.
    #[arg(long)]
    executable: String,

    /// Original user arguments passed to the intercepted executable.
    #[arg(last = true, allow_hyphen_values = true)]
    arguments: Vec<String>,
}

#[derive(Args, Debug)]
struct ListArgs {
    /// Include only managed or standalone sessions.
    #[arg(long, value_enum)]
    class: Option<SessionClassFilter>,
    /// Skip the exact liveness probe. The list then reports `unprobed`, which
    /// is never presented as health.
    #[arg(long)]
    no_probe: bool,
    /// Total wall-clock budget shared by discovery census and probing. A census
    /// that cannot finish inside it returns a typed timeout instead of a partial
    /// list; sessions not reached by the remaining probe time stay `unprobed`.
    #[arg(long, default_value_t = 1_500, value_parser = clap::value_parser!(u64).range(0..=60_000))]
    probe_budget_ms: u64,
    /// Versioned provider-neutral bounded catalog selection. Exact prioritized
    /// workspace/session identities are retained before deterministic fill.
    #[arg(long, value_name = "JSON", conflicts_with = "class")]
    catalog_query_json: Option<String>,
}

fn parse_session_catalog_query(source: &str) -> Result<SessionCatalogQuery, CliError> {
    serde_json::from_str(source).map_err(|_| {
        CliError(format!(
            "invalid session catalog query; expected schemaVersion {SESSION_CATALOG_QUERY_SCHEMA_VERSION}"
        ))
    })
}

#[derive(Clone, Copy, Debug, clap::ValueEnum)]
enum SessionClassFilter {
    Managed,
    Standalone,
}

#[derive(Debug)]
struct CliError(String);

impl fmt::Display for CliError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for CliError {}

fn parse_terminal_environment(
    assignments: &[String],
    removals: &[String],
) -> Result<TerminalEnvironment, CliError> {
    let mut values = BTreeMap::new();
    for assignment in assignments {
        let Some((key, value)) = assignment.split_once('=') else {
            return Err(CliError(format!(
                "--env requires NAME=VALUE, got `{assignment}`"
            )));
        };
        if values
            .insert(key.to_string(), Some(value.to_string()))
            .is_some()
        {
            return Err(CliError(format!(
                "terminal environment override `{key}` was specified more than once"
            )));
        }
    }
    for key in removals {
        if values.insert(key.to_string(), None).is_some() {
            return Err(CliError(format!(
                "terminal environment override `{key}` was specified more than once"
            )));
        }
    }
    TerminalEnvironment::new(values).map_err(|error| CliError(error.to_string()))
}

#[cfg(unix)]
fn gc_policy(args: &GcArgs) -> LocalStateGcPolicy {
    let mut policy = LocalStateGcPolicy::default();
    if args.all_eligible {
        policy.discovery.selection = DiscoveryGcSelection::AllEligible;
    }
    policy
}

#[cfg(unix)]
fn gc_human_lines(report: LocalStateGcReport, apply: bool, offer_apply: bool) -> Vec<String> {
    if !report.discovery_root_present {
        return vec!["No Hmux discovery state exists.".into()];
    }
    let mut lines = Vec::new();
    if report.recovery_source_busy {
        lines.push(if apply {
            "Cleanup skipped: a recovery operation currently owns source state.".into()
        } else {
            "Discovery cleanup preview skipped because recovery source-lock state is present; apply will recheck ownership.".into()
        });
    } else if report.recovery_source_locks.present_source_locks > 0 {
        lines.push(format!(
            "Recovery source locks: {} idle, 0 busy; idle lock files do not hide cleanup planning.",
            report.recovery_source_locks.idle_source_locks
        ));
    }
    if let Some(discovery) = report.discovery {
        lines.push(format!(
            "{} eligible retired or abandoned session entries; {} selected; {} protected.",
            discovery.eligible_sessions, discovery.planned_sessions, discovery.protected_sessions
        ));
        if apply {
            lines.push(format!(
                "Removed {} retired or abandoned session entries ({} bytes); {} protected.",
                discovery.removed_sessions, discovery.removed_bytes, discovery.protected_sessions
            ));
        } else {
            lines.push(format!(
                "Would remove {} retired or abandoned session entries; {} protected.",
                discovery.planned_sessions, discovery.protected_sessions
            ));
        }
        if report.discovery_selection == "retention"
            && discovery.eligible_sessions > discovery.planned_sessions
        {
            lines.push(
                "Use --all-eligible to select every age-qualified retired session entry.".into(),
            );
        }
        if discovery.budget_unmet {
            lines.push(
                "Some selected state remains because it could not be proven safe to remove.".into(),
            );
        }
        if discovery.remaining_state_incomplete || !discovery.diagnostics.is_empty() {
            lines.push(
                "Cleanup was incomplete; rerun with --json to inspect bounded diagnostics, quiesce active writers, then retry and require a zero-removal convergence pass.".into(),
            );
        }
    }
    if let Some(journal) = report.recovery_gc {
        if apply {
            lines.push(format!(
                "Removed {} completed recovery records and {} inactive lock/temp files.",
                journal.removed_completed_records,
                journal.removed_source_locks
                    + journal.removed_orphan_operation_locks
                    + journal.removed_temporary_files
            ));
        } else {
            lines.push(format!(
                "Would remove {} completed recovery records and {} inactive lock/temp files.",
                journal.planned_completed_records,
                journal.planned_source_locks
                    + journal.planned_orphan_operation_locks
                    + journal.planned_temporary_files
            ));
        }
    }
    if !apply && offer_apply {
        lines.push(
            "Run the same command again with `--apply`, preserving all global options.".into(),
        );
    }
    lines
}

fn main() {
    std::hint::black_box(&BUILD_PROVENANCE);
    if let Err(error) = run(Cli::parse()) {
        if output::is_broken_pipe(error.as_ref()) {
            return;
        }
        eprintln!("hmux: error: {error}");
        std::process::exit(1);
    }
}

fn run(cli: Cli) -> Result<(), Box<dyn std::error::Error>> {
    if matches!(&cli.command, Command::Capabilities) {
        if cli.json {
            cli_println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "schemaVersion": 2,
                    "cliVersion": env!("CARGO_PKG_VERSION"),
                    "buildInfo": {
                        "buildId": CLI_BUILD_ID,
                        "source": "hmux_cli",
                        "platform": {
                            "os": std::env::consts::OS,
                            "arch": std::env::consts::ARCH,
                        },
                        "protocol": {
                            "minimum": "1.0",
                            "maximum": "1.0",
                        },
                    },
                    "capabilities": CLI_CAPABILITIES,
                }))?
            )?;
        } else {
            cli_println!("{}", CLI_CAPABILITIES.join("\n"))?;
        }
        return Ok(());
    }

    // Pairing distributes keys; it never reads a session manifest. Returning
    // before the catalog is built keeps `hmux pair` working on a machine that
    // has never run a session — including the freshly provisioned server that
    // receives `apply-authorized-key` over ssh.
    let command = match cli.command {
        Command::Pair { command } => {
            return match command {
                PairCommand::Start(args) => pairing::start(args, cli.json),
                PairCommand::Offline(args) => pairing::offline::run(args, cli.json),
                PairCommand::List => pairing::list(cli.json),
                PairCommand::Revoke(args) => pairing::revoke(args, cli.json),
                PairCommand::ApplyAuthorizedKey => pairing::apply_authorized_key_stdio(false),
                PairCommand::RemoveAuthorizedKey => pairing::apply_authorized_key_stdio(true),
            };
        }
        other => other,
    };

    if matches!(&command, Command::DiscoveryCensus) {
        serve_catalog_census(std::io::stdin().lock(), std::io::stdout().lock())?;
        return Ok(());
    }

    let discovery_override = cli.discovery_root.clone();
    // Managed attachment owns discovery through its authorization broker, and
    // remote attachment owns no local discovery at all. Resolve both before
    // constructing the catalog so there is only one authority for each path.
    let command = match command {
        Command::ManagedAttach(args) => {
            refuse_nested_attach(true)?;
            let runtime = resolve_runtime_executable(None)?;
            managed_attach::attach_local(
                runtime,
                std::env::current_dir()?.canonicalize()?,
                discovery_override.as_deref(),
                args.session,
                args.workspace,
            )?;
            return Ok(());
        }
        Command::RemoteManagedAttach(args) => {
            refuse_nested_attach(true)?;
            remote_managed_attach::attach(remote_managed_attach::RemoteManagedAttach {
                session_id: args.session,
                workspace_id: args.workspace,
                host: args.host,
                port: args.port,
                user: args.user,
                connect_timeout_ms: args.connect_timeout_ms,
                identity_file: args.identity_file,
                ssh_agent: args.ssh_agent,
                known_hosts_file: args.known_hosts_file,
                expected_fence_json: args.expected_fence_json,
            })?;
            return Ok(());
        }
        other => other,
    };
    let catalog = match cli.discovery_root {
        Some(root) => Ok(LocalSessionCatalog::new(root)),
        None => LocalSessionCatalog::from_environment(),
    };

    if let Command::Runtime {
        command: RuntimeCommand::Status(args),
    } = &command
    {
        let status = runtime_status::collect(
            catalog,
            args.probe_budget_ms.map(Duration::from_millis),
            env!("CARGO_PKG_VERSION"),
            CLI_BUILD_ID,
            CLI_CAPABILITIES,
        );
        if cli.json {
            cli_println!("{}", serde_json::to_string(&status)?)?;
        } else {
            cli_print!("{}", runtime_status::render(&status))?;
        }
        return Ok(());
    }
    let catalog = catalog?;

    match command {
        Command::Capabilities => unreachable!("capability probe returned before discovery"),
        Command::Runtime { .. } => unreachable!("runtime status returned before session commands"),
        Command::Pair { .. } => unreachable!("pairing returned before discovery"),
        Command::ExactDiscoveryLookup => {
            serve_exact_discovery_lookup(
                &catalog,
                std::io::stdin().lock(),
                std::io::stdout().lock(),
            )?;
        }
        Command::DiscoveryCensus => {
            unreachable!("discovery census worker returned before local catalog resolution")
        }
        #[cfg(unix)]
        Command::StandaloneCreateOperation => {
            standalone_create_operation::serve(
                &catalog,
                std::io::stdin().lock(),
                std::io::stdout().lock(),
            )?;
        }
        #[cfg(unix)]
        Command::Doctor(args) => {
            let budget = Duration::from_millis(args.probe_budget_ms);
            let census_started = Instant::now();
            let worker = CatalogCensusWorker::new(std::env::current_exe()?);
            let descriptors = match list_local_sessions_isolated(&catalog, &worker, budget) {
                Ok(descriptors) => descriptors,
                Err(error) => {
                    if cli.json {
                        print_incomplete_census(&error)?;
                    }
                    return Err(Box::new(error));
                }
            };
            let remaining_budget = budget.saturating_sub(census_started.elapsed());
            let sessions = inspect_local_sessions(
                &catalog,
                descriptors,
                SESSION_INSPECTION_WORKERS,
                remaining_budget,
            );
            let mut policy = LocalStateGcPolicy::default();
            policy.discovery.selection = DiscoveryGcSelection::AllEligible;
            let state_gc =
                collect_local_state(catalog.discovery_root(), DiscoveryGcMode::Preview, &policy)?;
            let (scanned_sessions, eligible_orphans, oldest_orphan_age_ms) = state_gc
                .discovery
                .as_ref()
                .map(|discovery| {
                    (
                        discovery.scanned_sessions,
                        discovery.eligible_sessions,
                        discovery.eligible_oldest_age_ms,
                    )
                })
                .unwrap_or_default();
            let session_candidates = doctor_session_summary(
                sessions.iter().map(|session| session.health),
                scanned_sessions,
                eligible_orphans,
                oldest_orphan_age_ms,
            );
            if cli.json {
                cli_println!(
                    "{}",
                    serde_json::to_string_pretty(&LocalDoctorReport {
                        schema_version: 1,
                        discovery_root: catalog.discovery_root().to_path_buf(),
                        probe_budget_ms: args.probe_budget_ms,
                        session_candidates,
                        state_gc,
                    })?
                )?;
            } else {
                cli_println!(
                    "Sessions: {} healthy, {} stale, {} orphan cleanup candidates, {} indeterminate.",
                    session_candidates.healthy,
                    session_candidates.stale,
                    session_candidates.orphan,
                    session_candidates.indeterminate
                )?;
                cli_println!(
                    "  probe coverage: {}/{} ({} basis points, complete={})",
                    session_candidates.probed,
                    session_candidates.probe_targets,
                    session_candidates.probe_coverage_basis_points,
                    session_candidates.probe_complete
                )?;
                for reason in &session_candidates.reasons {
                    cli_println!("  {}: {}", reason.reason, reason.count)?;
                }
                for line in gc_human_lines(state_gc, false, false) {
                    cli_println!("{line}")?;
                }
            }
        }
        #[cfg(unix)]
        Command::Gc(args) => {
            let mode = if args.apply {
                DiscoveryGcMode::Apply
            } else {
                DiscoveryGcMode::Preview
            };
            let policy = gc_policy(&args);
            let report = collect_local_state(catalog.discovery_root(), mode, &policy)?;
            if cli.json {
                cli_println!("{}", serde_json::to_string_pretty(&report)?)?;
            } else {
                for line in gc_human_lines(report, args.apply, true) {
                    cli_println!("{line}")?;
                }
            }
        }
        #[cfg(unix)]
        Command::Process {
            command:
                ProcessInspectionCommand::Probe {
                    process_id,
                    start_marker,
                },
        } => {
            let process = ProcessDescriptor {
                process_id,
                start_marker,
            };
            let status = match probe_local_process_generation(&process)? {
                LocalProcessGenerationStatus::Live => "live",
                LocalProcessGenerationStatus::Absent => "absent",
            };
            if cli.json {
                cli_println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "schemaVersion": 1,
                        "process": process,
                        "status": status,
                    }))?
                )?;
            } else {
                cli_println!("{status}")?;
            }
        }
        Command::New(args) => {
            refuse_nested_attach(args.foreground)?;
            let cwd = std::env::current_dir()?.canonicalize()?;
            let (columns, rows) = crossterm::terminal::size().unwrap_or((80, 24));
            let request = hmux_client::StandaloneCreateRequest::new(
                cwd,
                args.name,
                args.command,
                rows.max(1),
                columns.max(1),
            )?
            .with_terminal_environment(parse_terminal_environment(
                &args.environment,
                &args.unset_environment,
            )?)?;
            let runtime = resolve_runtime_executable(args.runtime)?;
            let mut creator = StandaloneSessionCreator::new(runtime);
            if let Some(root) = discovery_override {
                creator = creator.with_discovery_root(absolute_discovery_root(root)?);
            }
            let created = creator.create(request)?;
            let session = created.session().clone();
            if cli.json {
                cli_println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "ok": true,
                        "sessionName": created.receipt().session_name(),
                        "sessionId": created.receipt().session_id(),
                        "workspaceId": created.receipt().workspace_id(),
                        "attach": format!("hmux attach {}", created.receipt().session_name()),
                    }))?
                )?;
            } else {
                cli_println!(
                    "Started hmux shell \"{}\" ({})",
                    created.receipt().session_name(),
                    short_session_id(created.receipt().session_id())
                )?;
                cli_println!(
                    "Reattach with: hmux attach {}",
                    created.receipt().session_name()
                )?;
            }
            if args.foreground {
                attach_foreground(&session, false)?;
            }
        }
        Command::Ls(args)
        | Command::Session {
            command: SessionCommand::List(args),
        } => {
            let budget = Duration::from_millis(args.probe_budget_ms);
            let census_started = Instant::now();
            let worker = CatalogCensusWorker::new(std::env::current_exe()?);
            let catalog_query = args
                .catalog_query_json
                .as_deref()
                .map(parse_session_catalog_query)
                .transpose()?;
            if catalog_query.is_some() && !cli.json {
                return Err(Box::new(CliError(
                    "--catalog-query-json requires --json".into(),
                )));
            }
            let (descriptors, catalog_output) = match catalog_query {
                Some(query) => {
                    let max_output_bytes = query.max_output_bytes();
                    match query_local_sessions_isolated(&catalog, &worker, query, budget) {
                        Ok(snapshot) => {
                            let output = BoundedCatalogOutputMetadata {
                                complete: snapshot.complete,
                                prioritized_items: snapshot.prioritized_items,
                                omitted_count: snapshot.truncation.omitted_count,
                                max_output_bytes,
                            };
                            (snapshot.sessions, Some(output))
                        }
                        Err(error) => {
                            print_incomplete_census(&error)?;
                            return Err(Box::new(error));
                        }
                    }
                }
                None => match list_local_sessions_isolated(&catalog, &worker, budget) {
                    Ok(descriptors) => (filter_sessions(descriptors, args.class), None),
                    Err(error) => {
                        if cli.json {
                            print_incomplete_census(&error)?;
                        }
                        return Err(Box::new(error));
                    }
                },
            };
            let remaining_budget = budget.saturating_sub(census_started.elapsed());
            let sessions = if args.no_probe {
                descriptors
                    .into_iter()
                    .map(SessionInspection::unprobed)
                    .collect()
            } else {
                inspect_local_sessions(
                    &catalog,
                    descriptors,
                    SESSION_INSPECTION_WORKERS,
                    remaining_budget,
                )
            };
            let discovery_root = catalog.discovery_root().to_path_buf();
            let liveness: Vec<SessionLiveness> = sessions
                .iter()
                .map(|session| {
                    session_liveness_for(
                        &session.descriptor,
                        session.probe_status(),
                        &discovery_root,
                    )
                })
                .collect();
            if cli.json {
                if let Some(metadata) = catalog_output {
                    cli_println!(
                        "{}",
                        serialize_bounded_session_catalog(&sessions, &liveness, metadata)?
                    )?;
                } else {
                    cli_println!(
                        "{}",
                        serde_json::to_string_pretty(&sessions_with_liveness(
                            &sessions, &liveness
                        ))?
                    )?;
                }
            } else {
                cli_print!("{}", render_sessions(&sessions, &liveness))?;
            }
        }
        Command::Session {
            command:
                SessionCommand::Show {
                    session_id,
                    workspace,
                },
        } => {
            let session = resolve_exact_session(&catalog, &session_id, workspace)?;
            let session = inspect_local_session(&catalog, session.descriptor().clone());
            if cli.json {
                cli_println!("{}", serde_json::to_string_pretty(&session)?)?;
            } else {
                cli_print!("{}", render_session(&session))?;
            }
        }
        Command::Session {
            command:
                SessionCommand::Probe {
                    session_id,
                    workspace,
                },
        } => {
            let session = resolve_exact_session(&catalog, &session_id, workspace)?;
            let inspection = inspect_local_session(&catalog, session.descriptor().clone());
            let (ok, status) = match inspection.health {
                SessionHealth::Healthy => (true, "healthy"),
                SessionHealth::StaleTransport => (false, "stale_transport"),
                SessionHealth::IncompatibleProtocol => (false, "incompatible_protocol"),
                SessionHealth::Exited => (false, "exited"),
                SessionHealth::GenerationChanged => (false, "generation_changed"),
                SessionHealth::Unprobed => (false, "unprobed"),
            };
            let payload = serde_json::json!({
                "schemaVersion": 1,
                "ok": ok,
                "sessionId": inspection.session_id,
                "workspaceId": inspection.workspace_id,
                "runnerPrincipal": inspection.runner_principal,
                "runnerInstance": inspection.runner_instance,
                "channelEpoch": inspection.channel_epoch,
                "hostInstanceId": inspection.host_instance_id,
                "terminalEpoch": inspection.terminal_epoch,
                "status": status,
            });
            if cli.json {
                cli_println!("{}", serde_json::to_string(&payload)?)?;
            } else {
                cli_println!("{status}")?;
            }
            if !ok {
                return Err(Box::new(CliError(format!(
                    "Hmux session probe reported {status}"
                ))));
            }
        }
        Command::Session {
            command: SessionCommand::ProbeBatch(args),
        } => {
            let selectors = exact_probe_batch::parse_selectors(&args)?;
            let worker = ExactDiscoveryWorker::new(std::env::current_exe()?);
            let results = inspect_local_sessions_exact_isolated(
                &catalog,
                &worker,
                selectors,
                SESSION_INSPECTION_WORKERS,
                Duration::from_millis(args.probe_budget_ms),
            )?;
            cli_print!("{}", exact_probe_batch::render(results, cli.json)?)?;
        }
        Command::Session {
            command:
                SessionCommand::Snapshot {
                    session_id,
                    workspace,
                },
        } => {
            let session = resolve_exact_session(&catalog, &session_id, workspace)?;
            let descriptor = session.descriptor().clone();
            let observer =
                LocalSessionObserver::connect_resolved(session, ObserverAttachOptions::default())?;
            let snapshot = observer.attachment().initial_snapshot.clone();
            observer.detach()?;
            let payload = serde_json::json!({
                "schemaVersion": 1,
                "sessionId": descriptor.session_id,
                "workspaceId": descriptor.workspace_id,
                "terminalEpoch": snapshot.terminal_epoch,
                "sequenceThrough": snapshot.sequence_through,
                "rows": snapshot.rows,
                "columns": snapshot.columns,
                "data": base64::engine::general_purpose::STANDARD.encode(snapshot.repaint_bytes),
                "alternateScreen": snapshot.alternate_screen,
                "cursorVisible": snapshot.cursor_visible,
                "truncated": snapshot.truncated,
                "agentIdentity": snapshot.agent_identity,
                "agentRuntimeState": snapshot.agent_runtime_state,
                "controllerInputPending": snapshot.controller_input_pending,
                "semanticIdleMs": snapshot.semantic_idle_ms,
            });
            cli_println!("{}", serde_json::to_string(&payload)?)?;
        }
        #[cfg(unix)]
        Command::Session {
            command:
                SessionCommand::RouteFiles {
                    session_id,
                    workspace,
                    terminal_epoch,
                    paths_json,
                },
        } => {
            let paths = serde_json::from_str(&paths_json)?;
            let paths = hmux_client::session_files::route_files(
                &catalog,
                &SessionSelector::new(session_id, Some(workspace)),
                &terminal_epoch,
                paths,
            )
            .map_err(CliError)?;
            cli_println!("{}", serde_json::to_string(&paths)?)?;
        }
        Command::Session {
            command: SessionCommand::CleanupExited(args),
        } => {
            let candidates = cleanup_exited_targets(&catalog, &args)?;
            let mut report = catalog.retire_exited_sessions(
                candidates.targets,
                if args.apply {
                    ExitedSessionRetirementMode::Apply
                } else {
                    ExitedSessionRetirementMode::Preview
                },
            )?;
            report.has_more = candidates.has_more;
            report.next_cursor = candidates.next_cursor;
            if cli.json {
                cli_println!("{}", serde_json::to_string_pretty(&report)?)?;
            } else {
                for line in cleanup_exited_human_lines(&report) {
                    cli_println!("{line}")?;
                }
            }
        }
        Command::Session {
            command: SessionCommand::Retirement { command },
        } => match command {
            SessionRetirementCommand::Show(target) => {
                let session = resolve_retirement_target(&catalog, &target)?;
                print_retirement_policy(cli.json, session.descriptor())?;
            }
            SessionRetirementCommand::Set {
                target,
                grace_period_ms,
            } => {
                let session = resolve_retirement_target(&catalog, &target)?;
                let receipt = session.configure_retirement_policy(Some(
                    SessionRetirementPolicy::AfterGracefulLastClientDepartureV1 { grace_period_ms },
                ))?;
                print_retirement_receipt(cli.json, "policy_set", session.descriptor(), &receipt)?;
            }
            SessionRetirementCommand::Clear(target) => {
                let session = resolve_retirement_target(&catalog, &target)?;
                let receipt = session.configure_retirement_policy(None)?;
                print_retirement_receipt(
                    cli.json,
                    "policy_cleared",
                    session.descriptor(),
                    &receipt,
                )?;
            }
            SessionRetirementCommand::Sweep(args) => {
                if let Some(session) = args.session {
                    let target = RetirementTargetArgs {
                        session,
                        workspace: args.workspace,
                    };
                    let session = resolve_retirement_target(&catalog, &target)?;
                    let receipt = if args.apply {
                        session.apply_retirement_sweep()
                    } else {
                        session.preview_retirement_sweep()
                    }?;
                    print_retirement_receipt(
                        cli.json,
                        if args.apply {
                            "sweep_applied"
                        } else {
                            "sweep_preview"
                        },
                        session.descriptor(),
                        &receipt,
                    )?;
                } else {
                    let summary = sweep_all_ready_standalone_sessions(&catalog, args.apply)?;
                    let has_failures = summary.has_failures();
                    print_retirement_sweep_summary(cli.json, &summary)?;
                    if has_failures {
                        return Err(Box::new(CliError(format!(
                            "session retirement sweep completed with {} refusal(s) and {} error(s)",
                            summary.refused, summary.errors
                        ))));
                    }
                }
            }
        },
        Command::Current => {
            let session = catalog.find(&current_session_selector()?)?;
            let session = inspect_local_session(&catalog, session);
            if cli.json {
                cli_println!("{}", serde_json::to_string_pretty(&session)?)?;
            } else {
                cli_print!("{}", render_session(&session))?;
            }
        }
        Command::MobileGateway(args) => {
            // Deliberately ignores `--json`: stdout carries protocol frames and
            // nothing else for the life of this process.
            if args.list {
                mobile_gateway::list_stdio(
                    &catalog,
                    args.session.as_deref(),
                    args.workspace.as_deref(),
                )?;
            } else {
                mobile_gateway::serve_stdio(
                    &catalog,
                    args.session.as_deref(),
                    args.workspace.as_deref(),
                    args.role,
                    if args.allow_create {
                        mobile_gateway::CreationAuthority::Granted
                    } else {
                        mobile_gateway::CreationAuthority::Withheld
                    },
                )?;
            }
        }
        Command::ProviderBridge(args) => {
            run_command_bridge(&catalog, args)?;
        }
        Command::Attach(args) => {
            refuse_nested_attach(true)?;
            let identifier = args.identifier()?;
            let worker = CatalogCensusWorker::new(std::env::current_exe()?);
            let resolved = match args.name.as_deref() {
                Some(name) => resolve_local_session_name_isolated(
                    &catalog,
                    &worker,
                    name,
                    CATALOG_CENSUS_BUDGET,
                ),
                None => resolve_local_session_isolated(
                    &catalog,
                    &worker,
                    identifier,
                    CATALOG_CENSUS_BUDGET,
                ),
            };
            let session = match resolved {
                Ok(session) => require_standalone(session)?,
                Err(error) if error.is_session_absent() => {
                    let runtime = resolve_runtime_executable(None)?;
                    match attach_recovery::recover_missing_named_attach(
                        &catalog, identifier, &runtime,
                    )? {
                        Some(session) => session,
                        None => return Err(Box::new(error)),
                    }
                }
                Err(error) => {
                    if cli.json {
                        if let Some(census_error) = error.census_error() {
                            print_incomplete_census(census_error)?;
                        }
                    }
                    return Err(Box::new(error));
                }
            };
            let session = match probe_local_session_exact(&catalog, session.descriptor()) {
                SessionProbeStatus::Healthy | SessionProbeStatus::IncompatibleProtocol => session,
                SessionProbeStatus::StaleTransport => {
                    let runtime = resolve_runtime_executable(None)?;
                    attach_recovery::recover_stale_attach(&catalog, &session, &runtime)?
                }
                SessionProbeStatus::Exited => {
                    return Err(Box::new(CliError(format!(
                        "Hmux session `{identifier}` has exited; use `hmux restore`"
                    ))));
                }
                SessionProbeStatus::GenerationChanged => {
                    return Err(Box::new(CliError(format!(
                        "Hmux session `{identifier}` changed generation; retry attach"
                    ))));
                }
            };
            attach_foreground(&session, args.read_only)?;
        }
        Command::ManagedAttach(_) | Command::RemoteManagedAttach(_) => {
            unreachable!("managed attach returned before local catalog resolution")
        }
        Command::Screen(args) => {
            let session = resolve_standalone(&catalog, &args.session)?;
            let snapshot = session.read_screen(None)?;
            if cli.json || args.format == ScreenFormat::Json {
                cli_println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "ok": true,
                        "sessionName": session.descriptor().session_name,
                        "sequenceThrough": snapshot.sequence_through.to_string(),
                        "rows": snapshot.rows,
                        "columns": snapshot.columns,
                        "encoding": format!("{:?}", snapshot.encoding),
                        "alternateScreen": snapshot.alternate_screen,
                        "cursorVisible": snapshot.cursor_visible,
                        "truncated": snapshot.truncated,
                        "repaintBase64": base64::engine::general_purpose::STANDARD
                            .encode(&snapshot.repaint_bytes),
                    }))?
                )?;
            } else {
                if snapshot.truncated {
                    eprintln!(
                        "hmux: warning: screen snapshot truncated at {} bytes",
                        snapshot.repaint_bytes.len()
                    );
                }
                output::write_bytes(&snapshot.repaint_bytes)?;
                output::flush()?;
            }
        }
        Command::SendKeys(args) => {
            let expected_fence = args
                .expected_fence_json
                .as_deref()
                .map(parse_expected_fence)
                .transpose()?;
            let session = match (args.workspace.as_deref(), expected_fence.as_ref()) {
                (Some(workspace_id), Some(expected)) => catalog.open_current_managed_for_mutation(
                    &SessionSelector::new(&args.session, Some(workspace_id.to_string())),
                    expected,
                )?,
                _ => resolve_readable_session(&catalog, &args.session, args.workspace.clone())?,
            };
            let bytes = encode_send_keys(&args.keys, args.literal)?;
            match session.descriptor().session_class {
                SessionClass::Standalone => {
                    if let Some(expected_fence) = expected_fence.as_ref() {
                        ensure_expected_fence(session.descriptor(), expected_fence)?;
                    }
                    let receipt = session.send_input(bytes)?;
                    if cli.json {
                        cli_println!(
                            "{}",
                            serde_json::to_string_pretty(&serde_json::json!({
                                "ok": true,
                                "sessionName": session.descriptor().session_name,
                                "requestId": receipt.request_id,
                                "controllerGeneration": receipt.controller_generation.to_string(),
                                "state": format!("{:?}", receipt.state),
                                "reason": receipt.reason.map(|reason| format!("{reason:?}")),
                            }))?
                        )?;
                    }
                }
                SessionClass::Managed => {
                    if expected_fence.is_none() {
                        return managed_mutation_failure(
                            cli.json,
                            "hmux_expected_generation_required",
                            "managed input requires --expected-fence-json".into(),
                            "not_written",
                        );
                    }
                    let receipt = match session.send_input(bytes) {
                        Ok(receipt) => receipt,
                        Err(error) => {
                            return managed_mutation_failure(
                                cli.json,
                                error.code(),
                                error.to_string(),
                                "unknown",
                            );
                        }
                    };
                    if cli.json {
                        cli_println!(
                            "{}",
                            serde_json::to_string_pretty(&serde_json::json!({
                                "schemaVersion": 1,
                                "ok": true,
                                "sessionName": session.descriptor().session_name,
                                "sessionId": session.descriptor().session_id,
                                "workspaceId": session.descriptor().workspace_id,
                                "receipt": {
                                    "requestId": receipt.request_id,
                                    "controllerGeneration": receipt.controller_generation.to_string(),
                                    "state": "written_to_pty",
                                    "reason": receipt.reason.map(|reason| format!("{reason:?}")),
                                    "detail": receipt.detail,
                                },
                            }))?
                        )?;
                    }
                }
            }
        }
        Command::AutomationInput(args) => semantic_input::execute(args, &catalog, cli.json)?,
        Command::Resize(args) => {
            let expected_fence = args
                .expected_fence_json
                .as_deref()
                .map(parse_expected_fence)
                .transpose()?;
            let session = match (args.workspace.as_deref(), expected_fence.as_ref()) {
                (Some(workspace_id), Some(expected)) => catalog.open_current_managed_for_mutation(
                    &SessionSelector::new(&args.session, Some(workspace_id.to_string())),
                    expected,
                )?,
                _ => resolve_readable_session(&catalog, &args.session, args.workspace.clone())?,
            };
            if session.descriptor().session_class == SessionClass::Managed
                && expected_fence.is_none()
            {
                return managed_mutation_failure(
                    cli.json,
                    "hmux_expected_generation_required",
                    "managed resize requires --expected-fence-json".into(),
                    "not_applied",
                );
            }
            if session.descriptor().session_class == SessionClass::Standalone {
                if let Some(expected_fence) = expected_fence.as_ref() {
                    ensure_expected_fence(session.descriptor(), expected_fence)?;
                }
            }
            let receipt = match session.send_resize(args.rows, args.columns) {
                Ok(receipt) => receipt,
                Err(error) => {
                    return managed_mutation_failure(
                        cli.json,
                        error.code(),
                        error.to_string(),
                        "unknown",
                    );
                }
            };
            if cli.json {
                cli_println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "schemaVersion": 1,
                        "ok": true,
                        "sessionName": session.descriptor().session_name,
                        "sessionId": session.descriptor().session_id,
                        "workspaceId": session.descriptor().workspace_id,
                        "receipt": {
                            "requestId": receipt.request_id,
                            "attachmentGeneration": receipt.controller_generation.to_string(),
                            "state": "applied_to_terminal",
                            "rows": receipt.rows,
                            "columns": receipt.columns,
                            "reason": receipt.reason.map(|reason| format!("{reason:?}")),
                        },
                    }))?
                )?;
            } else {
                cli_println!("{}x{}", args.columns, args.rows)?;
            }
        }
        Command::Read(args) => {
            screen_read::run(&catalog, args, cli.json)?;
        }
        Command::Kill(args) => {
            let session =
                resolve_readable_session(&catalog, &args.session, args.workspace.clone())?;
            let expected_fence = args
                .expected_fence_json
                .as_deref()
                .map(parse_expected_fence)
                .transpose()?;
            if let Some(expected_fence) = expected_fence.as_ref() {
                ensure_expected_fence(session.descriptor(), expected_fence)?;
            }
            match session.descriptor().session_class {
                SessionClass::Standalone => {
                    session
                        .terminate_standalone(&catalog, Duration::from_millis(args.timeout_ms))?;
                }
                SessionClass::Managed => {
                    let expected_fence = expected_fence.as_ref().ok_or_else(|| {
                        CliError(
                            "hmux_expected_generation_required: managed termination requires --expected-fence-json"
                                .into(),
                        )
                    })?;
                    let runtime = resolve_runtime_executable(args.runtime)?;
                    let working_directory = std::env::current_dir()?.canonicalize()?;
                    let request = ManagedStopRequest::new(
                        format!("cli_stop_{}", Uuid::new_v4().simple()),
                        session.descriptor().session_id.clone(),
                        session.descriptor().workspace_id.clone(),
                    )?
                    .with_expected_fence(
                        expected_fence.runner_principal.clone(),
                        expected_fence.runner_instance.clone(),
                        expected_fence.channel_epoch,
                        expected_fence.host_instance_id.clone(),
                        expected_fence.terminal_epoch.clone(),
                    )?;
                    ManagedSessionStopper::new(runtime, working_directory)
                        .with_discovery_root(catalog.discovery_root())
                        .stop(request)?;
                }
            }
            if cli.json {
                cli_println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "ok": true,
                        "sessionName": session.descriptor().session_name,
                        "sessionId": session.descriptor().session_id,
                        "sessionClass": session.descriptor().session_class,
                    }))?
                )?;
            }
        }
        Command::ManagedRehost(args) => {
            managed_rehost_execution::rehost(catalog.discovery_root(), args, cli.json)?;
        }
        Command::ManagedRehostReconcile(args) => {
            managed_rehost_execution::reconcile(catalog.discovery_root(), args, cli.json)?;
        }
        Command::ManagedRehostStart(args) => {
            managed_rehost_execution::start(&catalog, args, cli.json)?;
        }
        Command::ManagedRehostResolve(args) => {
            managed_rehost_observation::run(catalog.discovery_root(), args, cli.json)?;
        }
        Command::Restore(args) => {
            refuse_nested_attach(args.foreground)?;
            let resolved =
                resurrection::resolve_and_migrate(catalog.discovery_root(), &args.session)?;
            let recipe = resolved.recipe();
            if recipe.requires_operator_confirmation() && !args.run {
                return Err(Box::new(CliError(format!(
                    "`{}` used an explicit command; pass --run to confirm replay",
                    recipe.session_name()
                ))));
            }
            let runtime = resolve_runtime_executable(args.runtime)?;
            let request = recipe.to_create_request()?;
            let creator = StandaloneSessionCreator::new(runtime)
                .with_discovery_root(catalog.discovery_root());
            let created = creator.create(request)?;
            let session = created.session().clone();
            if cli.json {
                cli_println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "ok": true,
                        "restored": true,
                        "migratedLegacyRecipe": resolved.migrated_legacy(),
                        "sessionName": created.receipt().session_name(),
                        "sessionId": created.receipt().session_id(),
                    }))?
                )?;
            } else {
                if resolved.migrated_legacy() {
                    cli_println!(
                        "Imported legacy resurrection recipe for \"{}\"",
                        created.receipt().session_name()
                    )?;
                }
                cli_println!(
                    "Restored hmux shell \"{}\" ({})",
                    created.receipt().session_name(),
                    short_session_id(created.receipt().session_id())
                )?;
            }
            if args.foreground {
                attach_foreground(&session, false)?;
            }
        }
        Command::Upgrade(args) => {
            refuse_nested_attach(args.foreground)?;
            standalone_upgrade::run(&catalog, args, cli.json)?;
        }
    }
    Ok(())
}

fn print_incomplete_census(error: &CatalogCensusError) -> Result<(), Box<dyn std::error::Error>> {
    cli_println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "schemaVersion": 1,
            "complete": false,
            "sessions": [],
            "error": {
                "code": error.code(),
            },
        }))?
    )?;
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandBridgeMarker<'a> {
    schema_version: u16,
    event: &'static str,
    bridge_nonce: &'a str,
    source_session_id: &'a str,
    source_workspace_id: &'a str,
    target: CommandBridgeTarget<'a>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandBridgeTarget<'a> {
    session_id: &'a str,
    workspace_id: &'a str,
    session_class: &'static str,
    lifecycle: &'static str,
    provider_id: &'a str,
    runner_principal: &'a str,
    runner_instance: &'a str,
    channel_epoch: &'a str,
    host_instance_id: &'a str,
    terminal_epoch: &'a str,
}

fn run_command_bridge(
    catalog: &LocalSessionCatalog,
    args: CommandBridgeArgs,
) -> Result<(), Box<dyn std::error::Error>> {
    let expected_nonce = std::env::var("DURE_HMUX_COMMAND_BRIDGE_NONCE")
        .map_err(|_| CliError("command bridge is not inside a Dure remote shell".into()))?;
    if expected_nonce != args.bridge_nonce {
        return Err(Box::new(CliError(
            "command bridge nonce does not match its source session".into(),
        )));
    }
    let source_session_id = std::env::var(HMUX_SESSION_ID_ENV)
        .map_err(|_| CliError("command bridge source has no Hmux session identity".into()))?;
    let source_workspace_id = std::env::var(HMUX_WORKSPACE_ID_ENV)
        .map_err(|_| CliError("command bridge source has no Hmux workspace identity".into()))?;
    let source = catalog.open(&SessionSelector::new(
        &source_session_id,
        Some(source_workspace_id.clone()),
    ))?;
    if source.descriptor().session_class != SessionClass::Standalone
        || source.descriptor().lifecycle != SessionLifecycle::Ready
    {
        return Err(Box::new(CliError(
            "command bridge source is not a ready standalone session".into(),
        )));
    }
    let resolved = command_bridge_executable::resolve(&args.bridge_dir, &args.executable)?;
    let cwd = std::env::current_dir()?.canonicalize()?;
    let workspace_id = workspace_id_for_path(&cwd);
    let operation = Uuid::new_v4().simple().to_string();
    let idempotency_key = format!("command_bridge_{operation}");
    let session_id = format!("managed_{}", &operation[..24]);
    let (columns, rows) = crossterm::terminal::size().unwrap_or((80, 24));
    let mut command = resolved.command;
    command.extend(args.arguments);
    let request = ManagedCreateRequest::new(
        &idempotency_key,
        &session_id,
        &workspace_id,
        &args.provider_id,
        PermissionMode::Default,
        &cwd,
        command,
        rows.max(1),
        columns.max(1),
    )?
    .with_required_managed_stop_request_version(
        hmux_runtime_contract::MANAGED_STOP_CONVERSATION_FENCE_REQUEST_VERSION,
    )?;
    let runtime = resolve_runtime_executable(None)?;
    let created = ManagedSessionCreator::new(runtime)
        .with_discovery_root(catalog.discovery_root())
        .create(request)?;
    let target = created.session().descriptor().clone();
    emit_command_bridge_marker(
        &args.bridge_nonce,
        &source_session_id,
        &source_workspace_id,
        &target,
    )?;

    // The source shell remains blocked while its managed child owns the pane.
    // Once the provider exits, returning from this hidden command restores the
    // ordinary remote prompt that was underneath it.
    loop {
        match catalog.find(&SessionSelector::new(
            &target.session_id,
            Some(target.workspace_id.clone()),
        )) {
            Ok(current) if current.lifecycle == SessionLifecycle::Ready => {
                thread::sleep(Duration::from_millis(200));
            }
            Ok(_) => break,
            Err(error) if error.is_session_absent() => break,
            Err(error) => return Err(Box::new(error)),
        }
    }
    Ok(())
}

fn emit_command_bridge_marker(
    bridge_nonce: &str,
    source_session_id: &str,
    source_workspace_id: &str,
    target: &SessionDescriptor,
) -> Result<(), Box<dyn std::error::Error>> {
    cli_print!(
        "{}",
        encode_command_bridge_marker(bridge_nonce, source_session_id, source_workspace_id, target,)?
    )?;
    std::io::stdout().flush()?;
    Ok(())
}

fn encode_command_bridge_marker(
    bridge_nonce: &str,
    source_session_id: &str,
    source_workspace_id: &str,
    target: &SessionDescriptor,
) -> Result<String, serde_json::Error> {
    let marker = CommandBridgeMarker {
        schema_version: 1,
        event: "managed_started",
        bridge_nonce,
        source_session_id,
        source_workspace_id,
        target: CommandBridgeTarget {
            session_id: &target.session_id,
            workspace_id: &target.workspace_id,
            session_class: "managed",
            lifecycle: "ready",
            provider_id: &target.provider_id,
            runner_principal: &target.runner_principal,
            runner_instance: &target.runner_instance,
            channel_epoch: &target.channel_epoch,
            host_instance_id: &target.host_instance_id,
            terminal_epoch: &target.terminal_epoch,
        },
    };
    let payload = serde_json::to_vec(&marker)?;
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload);
    Ok(format!(
        "\u{1b}]778;dure-hmux-command-bridge-v1;{encoded}\u{7}"
    ))
}

pub(crate) fn resolve_runtime_executable(configured: Option<PathBuf>) -> Result<PathBuf, CliError> {
    let candidates = configured
        .into_iter()
        .chain(
            std::env::var_os("HMUX_RUNTIME")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from),
        )
        .chain(
            std::env::var_os("HEBBIAN_HMUX_RUNTIME")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from),
        )
        .chain(
            std::env::current_exe()
                .ok()
                .and_then(|path| path.parent().map(|parent| parent.join("hmux-runtime"))),
        )
        .chain([
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/debug/hmux-runtime"),
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/release/hmux-runtime"),
        ])
        .chain(dirs::home_dir().map(|home| {
            home.join(".local/share/hmux")
                .join("current")
                .join("bin")
                .join(format!("hmux-runtime{}", std::env::consts::EXE_SUFFIX))
        }))
        .chain(dirs::home_dir().map(|home| home.join(".local/bin/hmux-runtime")));
    for candidate in candidates {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(CliError(
        "hmux-runtime was not found; build the workspace or set HMUX_RUNTIME".into(),
    ))
}

fn absolute_discovery_root(path: PathBuf) -> Result<PathBuf, io::Error> {
    if path.is_absolute() {
        return Ok(path);
    }
    Ok(std::env::current_dir()?.join(path))
}

fn current_session_selector() -> Result<SessionSelector, CliError> {
    current_session_selector_from(|name| std::env::var(name).ok().filter(|value| !value.is_empty()))
}

fn current_session_selector_from(
    mut environment: impl FnMut(&str) -> Option<String>,
) -> Result<SessionSelector, CliError> {
    if environment(HMUX_ENV).is_none() {
        return Err(CliError(
            "current is available only inside an Hmux-hosted provider".into(),
        ));
    }
    let session_id = environment(HMUX_SESSION_ID_ENV).ok_or_else(|| {
        CliError(
            "current Hmux provider has no HMUX_SESSION_ID; start or restore it with a current runtime"
                .into(),
        )
    })?;
    let workspace_id = environment(HMUX_WORKSPACE_ID_ENV).ok_or_else(|| {
        CliError(
            "current Hmux provider has no HMUX_WORKSPACE_ID; start or restore it with a current runtime"
                .into(),
        )
    })?;
    Ok(SessionSelector::new(session_id, Some(workspace_id)))
}

fn recent_visible_lines(
    repaint_bytes: &[u8],
    rows: u16,
    columns: u16,
    maximum: u16,
) -> Vec<String> {
    let mut parser = vt100::Parser::new(rows.max(1), columns.max(1), 0);
    parser.process(repaint_bytes);
    let contents = parser.screen().contents();
    let mut lines = contents
        .lines()
        .map(|line| line.trim_end().to_string())
        .collect::<Vec<_>>();
    while lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    let retain = usize::from(maximum);
    if lines.len() > retain {
        lines.drain(..lines.len() - retain);
    }
    lines
}

fn resolve_standalone(
    catalog: &LocalSessionCatalog,
    identifier: &str,
) -> Result<LocalSession, Box<dyn std::error::Error>> {
    let worker = CatalogCensusWorker::new(std::env::current_exe()?);
    require_standalone(resolve_local_session_isolated(
        catalog,
        &worker,
        identifier,
        CATALOG_CENSUS_BUDGET,
    )?)
}

fn resolve_exact_session(
    catalog: &LocalSessionCatalog,
    session_id: &str,
    workspace_id: Option<String>,
) -> Result<LocalSession, Box<dyn std::error::Error>> {
    match workspace_id {
        Some(workspace_id) => {
            Ok(catalog.open(&SessionSelector::new(session_id, Some(workspace_id)))?)
        }
        None => {
            let worker = CatalogCensusWorker::new(std::env::current_exe()?);
            Ok(resolve_local_session_id_isolated(
                catalog,
                &worker,
                session_id,
                CATALOG_CENSUS_BUDGET,
            )?)
        }
    }
}

fn resolve_retirement_target(
    catalog: &LocalSessionCatalog,
    target: &RetirementTargetArgs,
) -> Result<LocalSession, Box<dyn std::error::Error>> {
    match target.workspace.as_ref() {
        Some(workspace) => require_standalone(catalog.open(&SessionSelector::new(
            target.session.clone(),
            Some(workspace.clone()),
        ))?),
        None => resolve_standalone(catalog, &target.session),
    }
}

fn cleanup_exited_targets(
    catalog: &LocalSessionCatalog,
    args: &CleanupExitedArgs,
) -> Result<ExitedSessionRetirementCandidates, Box<dyn std::error::Error>> {
    if args.expected_generation_json.len() > MAX_EXITED_SESSION_RETIREMENT_TARGETS {
        return Err(CliError(format!(
            "cleanup apply has {} generations; maximum is {}",
            args.expected_generation_json.len(),
            MAX_EXITED_SESSION_RETIREMENT_TARGETS
        ))
        .into());
    }
    if !args.expected_generation_json.is_empty() {
        if !args.apply {
            return Err(CliError(
                "--expected-generation-json is apply authority and requires --apply".into(),
            )
            .into());
        }
        if args.session.is_some() && args.expected_generation_json.len() != 1 {
            return Err(CliError(
                "a positional session id accepts exactly one expected generation".into(),
            )
            .into());
        }
        let mut targets = Vec::with_capacity(args.expected_generation_json.len());
        for encoded in &args.expected_generation_json {
            let generation = parse_cleanup_generation(encoded)?;
            let identifier = args
                .session
                .clone()
                .unwrap_or_else(|| generation.fence.session_id.clone());
            if identifier != generation.fence.session_id {
                return Err(CliError(
                    "the positional session id must match --expected-generation-json".into(),
                )
                .into());
            }
            let workspace = args
                .workspace
                .clone()
                .unwrap_or_else(|| generation.fence.workspace_id.clone());
            targets.push(
                ExitedSessionRetirementTarget::new(
                    workspace,
                    identifier,
                    args.expected_terminal_epoch.clone(),
                )
                .with_generation(generation),
            );
        }
        return Ok(ExitedSessionRetirementCandidates {
            targets,
            has_more: false,
            next_cursor: None,
        });
    }
    if args.apply {
        return Err(CliError(
            "--apply requires at least one --expected-generation-json from preview".into(),
        )
        .into());
    }
    if let Some(identifier) = &args.session {
        let workspace = args.workspace.as_ref().ok_or_else(|| {
            CliError(
                "an exact cleanup target requires --workspace; use JSON preview to obtain it"
                    .into(),
            )
        })?;
        let session = catalog.open(&SessionSelector::new(
            identifier.clone(),
            Some(workspace.clone()),
        ))?;
        let descriptor = session.descriptor();
        let generation = ExitedSessionRetirementGeneration::from_descriptor(descriptor)?;
        return Ok(ExitedSessionRetirementCandidates {
            targets: vec![
                ExitedSessionRetirementTarget::new(
                    descriptor.workspace_id.clone(),
                    descriptor.session_id.clone(),
                    args.expected_terminal_epoch
                        .clone()
                        .or_else(|| Some(descriptor.terminal_epoch.clone())),
                )
                .with_generation(generation),
            ],
            has_more: false,
            next_cursor: None,
        });
    }

    let cursor = args
        .after_cursor_json
        .as_deref()
        .map(parse_cleanup_cursor)
        .transpose()?;
    catalog
        .exited_retirement_candidates_after(cursor.as_ref())
        .map_err(Into::into)
}

fn cleanup_exited_human_lines(report: &ExitedSessionRetirementReport) -> Vec<String> {
    let mut lines = vec![match report.mode {
        ExitedSessionRetirementMode::Preview => format!(
            "{} exited session(s) evaluated; {} eligible; {} protected.",
            report.evaluated, report.retirable, report.skipped
        ),
        ExitedSessionRetirementMode::Apply => format!(
            "{} exited session(s) evaluated; {} archived; {} already archived; {} protected.",
            report.evaluated, report.retired, report.already_retired, report.skipped
        ),
    }];
    for result in &report.results {
        let outcome = match result.outcome {
            ExitedSessionRetirementOutcome::Retirable => "retirable",
            ExitedSessionRetirementOutcome::Retired => "retired",
            ExitedSessionRetirementOutcome::AlreadyRetired => "already_retired",
            ExitedSessionRetirementOutcome::Skipped => "skipped",
        };
        let reason = result
            .reason
            .map(cleanup_exited_reason_name)
            .map(|reason| format!(" ({reason})"))
            .unwrap_or_default();
        let message = result
            .message
            .as_ref()
            .map(|message| format!(": {message}"))
            .unwrap_or_default();
        lines.push(format!(
            "{}/{}: {outcome}{reason}{message}",
            result.workspace_id, result.session_id
        ));
    }
    if report.mode == ExitedSessionRetirementMode::Preview {
        lines.push(
            "Preview only; apply requires each JSON result.generation via \
             `--expected-generation-json`."
                .into(),
        );
    }
    if report.has_more {
        lines.push("More exited sessions remain; continue with the JSON nextCursor.".into());
        if let Some(cursor) = &report.next_cursor {
            if let Ok(encoded) = serde_json::to_string(cursor) {
                lines.push(format!("nextCursor={encoded}"));
            }
        }
    }
    lines
}

fn cleanup_exited_reason_name(reason: ExitedSessionRetirementReason) -> &'static str {
    match reason {
        ExitedSessionRetirementReason::NotFound => "not_found",
        ExitedSessionRetirementReason::NotExited => "not_exited",
        ExitedSessionRetirementReason::NotStale => "not_stale",
        ExitedSessionRetirementReason::RecoveryPending => "recovery_pending",
        ExitedSessionRetirementReason::EpochChanged => "epoch_changed",
        ExitedSessionRetirementReason::GenerationChanged => "generation_changed",
        ExitedSessionRetirementReason::GenerationRequired => "generation_required",
        ExitedSessionRetirementReason::LifetimeBusy => "lifetime_busy",
        ExitedSessionRetirementReason::JournalUnavailable => "journal_unavailable",
        ExitedSessionRetirementReason::ArchiveCapacity => "archive_capacity",
        ExitedSessionRetirementReason::InvalidTarget => "invalid_target",
        ExitedSessionRetirementReason::Error => "error",
    }
}

#[derive(Debug)]
struct RetirementSweepSelection {
    candidates: Vec<SessionDescriptor>,
    skipped_managed: usize,
    skipped_exited: usize,
}

fn select_retirement_sweep_candidates(
    sessions: Vec<SessionDescriptor>,
) -> RetirementSweepSelection {
    let mut selection = RetirementSweepSelection {
        candidates: Vec::new(),
        skipped_managed: 0,
        skipped_exited: 0,
    };
    for session in sessions {
        if session.lifecycle == SessionLifecycle::Exited {
            selection.skipped_exited += 1;
        } else if session.session_class == SessionClass::Managed {
            selection.skipped_managed += 1;
        } else {
            selection.candidates.push(session);
        }
    }
    selection.candidates.sort_by(|left, right| {
        (&left.workspace_id, &left.session_id).cmp(&(&right.workspace_id, &right.session_id))
    });
    selection
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RetirementSweepResult {
    session_id: String,
    workspace_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_name: Option<String>,
    #[serde(flatten)]
    outcome: RetirementSweepOutcome,
}

#[derive(Debug, serde::Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
enum RetirementSweepOutcome {
    Receipt {
        request_id: String,
        state: SessionRetirementReceiptState,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<SessionRetirementReceiptReason>,
        #[serde(skip_serializing_if = "Option::is_none")]
        policy: Option<SessionRetirementPolicy>,
    },
    Error {
        code: String,
        message: String,
    },
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RetirementSweepSummary {
    schema_version: u16,
    mode: &'static str,
    evaluated: usize,
    accepted: usize,
    retirement_armed: usize,
    eligible: usize,
    preserved: usize,
    refused: usize,
    errors: usize,
    skipped_managed: usize,
    skipped_exited: usize,
    results: Vec<RetirementSweepResult>,
}

impl RetirementSweepSummary {
    fn new(apply: bool, skipped_managed: usize, skipped_exited: usize) -> Self {
        Self {
            schema_version: 1,
            mode: if apply { "apply" } else { "preview" },
            evaluated: 0,
            accepted: 0,
            retirement_armed: 0,
            eligible: 0,
            preserved: 0,
            refused: 0,
            errors: 0,
            skipped_managed,
            skipped_exited,
            results: Vec::new(),
        }
    }

    fn push_receipt(&mut self, descriptor: &SessionDescriptor, receipt: SessionRetirementReceipt) {
        self.evaluated += 1;
        match receipt.state {
            SessionRetirementReceiptState::PolicyUpdated => self.accepted += 1,
            SessionRetirementReceiptState::RetirementArmed => {
                self.accepted += 1;
                self.retirement_armed += 1;
            }
            SessionRetirementReceiptState::Eligible => {
                self.accepted += 1;
                self.eligible += 1;
            }
            SessionRetirementReceiptState::SessionPreserved => {
                self.accepted += 1;
                self.preserved += 1;
            }
            SessionRetirementReceiptState::Refused => self.refused += 1,
        }
        self.results.push(RetirementSweepResult {
            session_id: descriptor.session_id.clone(),
            workspace_id: descriptor.workspace_id.clone(),
            session_name: descriptor.session_name.clone(),
            outcome: RetirementSweepOutcome::Receipt {
                request_id: receipt.request_id,
                state: receipt.state,
                reason: receipt.reason,
                policy: receipt.policy,
            },
        });
    }

    fn push_error(
        &mut self,
        descriptor: &SessionDescriptor,
        code: impl Into<String>,
        message: impl Into<String>,
    ) {
        self.evaluated += 1;
        self.errors += 1;
        self.results.push(RetirementSweepResult {
            session_id: descriptor.session_id.clone(),
            workspace_id: descriptor.workspace_id.clone(),
            session_name: descriptor.session_name.clone(),
            outcome: RetirementSweepOutcome::Error {
                code: code.into(),
                message: message.into(),
            },
        });
    }

    fn has_failures(&self) -> bool {
        self.refused != 0 || self.errors != 0
    }
}

fn sweep_all_ready_standalone_sessions(
    catalog: &LocalSessionCatalog,
    apply: bool,
) -> Result<RetirementSweepSummary, Box<dyn std::error::Error>> {
    let worker = CatalogCensusWorker::new(std::env::current_exe()?);
    let sessions = list_local_sessions_isolated(catalog, &worker, CATALOG_CENSUS_BUDGET)?;
    let selection = select_retirement_sweep_candidates(sessions);
    let mut summary =
        RetirementSweepSummary::new(apply, selection.skipped_managed, selection.skipped_exited);

    for observed in selection.candidates {
        let selector = SessionSelector::new(
            observed.session_id.clone(),
            Some(observed.workspace_id.clone()),
        );
        let session = match catalog.open(&selector) {
            Ok(session) => session,
            Err(error) => {
                summary.push_error(&observed, error.code(), error.to_string());
                continue;
            }
        };
        let current = session.descriptor();
        if current.lifecycle == SessionLifecycle::Exited {
            summary.skipped_exited += 1;
            continue;
        }
        if current.session_class == SessionClass::Managed {
            summary.skipped_managed += 1;
            continue;
        }
        if !current.same_generation(&observed) {
            summary.push_error(
                &observed,
                "hmux_identity_mismatch",
                "session generation changed after catalog enumeration; replacement was not swept",
            );
            continue;
        }

        let receipt = if apply {
            session.apply_retirement_sweep()
        } else {
            session.preview_retirement_sweep()
        };
        match receipt {
            Ok(receipt) => summary.push_receipt(&observed, receipt),
            Err(error) => summary.push_error(&observed, error.code(), error.to_string()),
        }
    }

    Ok(summary)
}

fn retirement_policy_name(policy: Option<SessionRetirementPolicy>) -> String {
    match policy {
        Some(SessionRetirementPolicy::AfterGracefulLastClientDepartureV1 { grace_period_ms }) => {
            format!("after_graceful_last_client_departure_v1 ({grace_period_ms} ms)")
        }
        None => "retain_until_explicit_stop".into(),
    }
}

fn print_retirement_policy(
    json: bool,
    descriptor: &SessionDescriptor,
) -> Result<(), Box<dyn std::error::Error>> {
    let supported = descriptor
        .capabilities
        .iter()
        .any(|capability| capability == SESSION_RETIREMENT_CAPABILITY);
    if json {
        cli_println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "schemaVersion": 1,
                "sessionId": descriptor.session_id,
                "workspaceId": descriptor.workspace_id,
                "supported": supported,
                "policy": descriptor.retirement_policy,
            }))?
        )?;
    } else {
        cli_println!(
            "Retirement policy: {}",
            retirement_policy_name(descriptor.retirement_policy)
        )?;
        cli_println!(
            "Host support: {}",
            if supported {
                "available"
            } else {
                "unsupported"
            }
        )?;
    }
    Ok(())
}

fn retirement_state_name(state: SessionRetirementReceiptState) -> &'static str {
    match state {
        SessionRetirementReceiptState::PolicyUpdated => "policy_updated",
        SessionRetirementReceiptState::RetirementArmed => "retirement_armed",
        SessionRetirementReceiptState::Eligible => "eligible",
        SessionRetirementReceiptState::SessionPreserved => "session_preserved",
        SessionRetirementReceiptState::Refused => "refused",
    }
}

fn retirement_reason_name(reason: SessionRetirementReceiptReason) -> &'static str {
    match reason {
        SessionRetirementReceiptReason::PolicyNotConfigured => "policy_not_configured",
        SessionRetirementReceiptReason::OtherClientsAttached => "other_clients_attached",
        SessionRetirementReceiptReason::ProviderBusy => "provider_busy",
        SessionRetirementReceiptReason::ProviderIdentityChanged => "provider_identity_changed",
        SessionRetirementReceiptReason::ProcessObservationUnavailable => {
            "process_observation_unavailable"
        }
        SessionRetirementReceiptReason::PersistenceUnavailable => "persistence_unavailable",
        SessionRetirementReceiptReason::SessionExited => "session_exited",
        SessionRetirementReceiptReason::GenerationChanged => "generation_changed",
        SessionRetirementReceiptReason::HostExiting => "host_exiting",
        SessionRetirementReceiptReason::ManagedSession => "managed_session",
        SessionRetirementReceiptReason::UnsupportedAction => "unsupported_action",
    }
}

fn print_retirement_sweep_summary(
    json: bool,
    summary: &RetirementSweepSummary,
) -> Result<(), Box<dyn std::error::Error>> {
    if json {
        cli_println!("{}", serde_json::to_string_pretty(summary)?)?;
        return Ok(());
    }

    for result in &summary.results {
        let label = result.session_name.as_deref().unwrap_or(&result.session_id);
        match &result.outcome {
            RetirementSweepOutcome::Receipt {
                request_id,
                state,
                reason,
                policy,
            } => {
                cli_println!(
                    "{} [{}/{}]: {}; policy={}; request={}",
                    label,
                    result.workspace_id,
                    result.session_id,
                    retirement_state_name(*state),
                    retirement_policy_name(*policy),
                    request_id
                )?;
                if let Some(reason) = reason {
                    cli_println!("  reason={}", retirement_reason_name(*reason))?;
                }
            }
            RetirementSweepOutcome::Error { code, message } => {
                cli_println!(
                    "{} [{}/{}]: error {}: {}",
                    label,
                    result.workspace_id,
                    result.session_id,
                    code,
                    message
                )?;
            }
        }
    }
    cli_println!(
        "Retirement sweep {}: {} evaluated, {} accepted, {} armed, {} eligible, {} preserved, {} refused, {} errors; {} managed and {} exited skipped.",
        summary.mode,
        summary.evaluated,
        summary.accepted,
        summary.retirement_armed,
        summary.eligible,
        summary.preserved,
        summary.refused,
        summary.errors,
        summary.skipped_managed,
        summary.skipped_exited
    )?;
    Ok(())
}

fn print_retirement_receipt(
    json: bool,
    operation: &str,
    descriptor: &SessionDescriptor,
    receipt: &SessionRetirementReceipt,
) -> Result<(), Box<dyn std::error::Error>> {
    let accepted = receipt.state != SessionRetirementReceiptState::Refused;
    if json {
        cli_println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "schemaVersion": 1,
                "ok": accepted,
                "operation": operation,
                "sessionId": descriptor.session_id,
                "workspaceId": descriptor.workspace_id,
                "requestId": receipt.request_id,
                "state": receipt.state,
                "reason": receipt.reason,
                "policy": receipt.policy,
            }))?
        )?;
    } else {
        cli_println!(
            "Session retirement {operation}: {}",
            retirement_state_name(receipt.state)
        )?;
        cli_println!(
            "Retirement policy: {}",
            retirement_policy_name(receipt.policy)
        )?;
        if let Some(reason) = receipt.reason {
            let reason = serde_json::to_value(reason)?;
            cli_println!("Reason: {}", reason.as_str().unwrap_or("unknown"))?;
        }
    }
    if !accepted {
        return Err(Box::new(CliError(format!(
            "Hmux Host refused session retirement {operation}"
        ))));
    }
    Ok(())
}

const EXPECTED_FENCE_JSON_MAX_BYTES: usize = 4 * 1024;

fn parse_cleanup_generation(raw: &str) -> Result<ExitedSessionRetirementGeneration, CliError> {
    if raw.len() > EXPECTED_FENCE_JSON_MAX_BYTES {
        return Err(CliError(
            "hmux_expected_generation_invalid: cleanup generation exceeds 4096 bytes".into(),
        ));
    }
    serde_json::from_str(raw).map_err(|error| {
        CliError(format!(
            "hmux_expected_generation_invalid: cleanup generation is not valid JSON ({error})"
        ))
    })
}

fn parse_cleanup_cursor(raw: &str) -> Result<ExitedSessionRetirementCursor, CliError> {
    if raw.len() > EXPECTED_FENCE_JSON_MAX_BYTES {
        return Err(CliError(
            "hmux_exited_retirement_cursor_invalid: cursor exceeds 4096 bytes".into(),
        ));
    }
    serde_json::from_str(raw).map_err(|error| {
        CliError(format!(
            "hmux_exited_retirement_cursor_invalid: cursor is not valid JSON ({error})"
        ))
    })
}

fn parse_expected_fence(raw: &str) -> Result<SessionFence, CliError> {
    if raw.len() > EXPECTED_FENCE_JSON_MAX_BYTES {
        return Err(CliError(
            "hmux_expected_generation_invalid: expected fence exceeds 4096 bytes".into(),
        ));
    }
    let fence: SessionFence = serde_json::from_str(raw).map_err(|error| {
        CliError(format!(
            "hmux_expected_generation_invalid: expected fence is not valid JSON ({error})"
        ))
    })?;
    if [
        fence.workspace_id.as_str(),
        fence.session_id.as_str(),
        fence.runner_principal.as_str(),
        fence.runner_instance.as_str(),
        fence.host_instance_id.as_str(),
        fence.terminal_epoch.as_str(),
    ]
    .into_iter()
    .any(str::is_empty)
    {
        return Err(CliError(
            "hmux_expected_generation_invalid: expected fence fields must not be empty".into(),
        ));
    }
    Ok(fence)
}

fn ensure_expected_fence(
    descriptor: &SessionDescriptor,
    expected: &SessionFence,
) -> Result<(), CliError> {
    if descriptor.matches_fence(expected) {
        return Ok(());
    }
    Err(CliError(
        "hmux_expected_generation_mismatch: refusing to mutate a replacement session".into(),
    ))
}

fn managed_rehost_error_json(error: &ClientError) -> serde_json::Value {
    serde_json::json!({
        "schema": MANAGED_REHOST_SCHEMA,
        "schemaVersion": MANAGED_REHOST_SCHEMA_VERSION,
        "state": "refused",
        "error": {
            "code": error.code(),
            "message": error.to_string(),
        },
    })
}

fn managed_mutation_failure(
    json: bool,
    code: &str,
    message: String,
    delivery_state: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    if json {
        cli_println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "schemaVersion": 1,
                "ok": false,
                "error": {
                    "code": code,
                    "message": &message,
                    "deliveryState": delivery_state,
                },
            }))?
        )?;
    }
    Err(Box::new(CliError(format!("{code}: {message}"))))
}

fn resolve_readable_session(
    catalog: &LocalSessionCatalog,
    identifier: &str,
    workspace_id: Option<String>,
) -> Result<LocalSession, Box<dyn std::error::Error>> {
    match workspace_id {
        Some(workspace_id) => {
            Ok(catalog
                .open_current_managed(&SessionSelector::new(identifier, Some(workspace_id)))?)
        }
        None => {
            let worker = CatalogCensusWorker::new(std::env::current_exe()?);
            Ok(resolve_local_session_isolated(
                catalog,
                &worker,
                identifier,
                CATALOG_CENSUS_BUDGET,
            )?)
        }
    }
}

fn resolve_upgrade_source(
    catalog: &LocalSessionCatalog,
    identifier: &str,
) -> Result<LocalSession, Box<dyn std::error::Error>> {
    let worker = CatalogCensusWorker::new(std::env::current_exe()?);
    let sessions = list_local_sessions_isolated(catalog, &worker, CATALOG_CENSUS_BUDGET)?;
    let mut ready_named = sessions
        .iter()
        .filter(|session| {
            session.session_class == SessionClass::Standalone
                && session.lifecycle == SessionLifecycle::Ready
                && session.session_name.as_deref() == Some(identifier)
        })
        .cloned()
        .collect::<Vec<_>>();
    match ready_named.len() {
        0 => require_standalone(resolve_local_session_from_complete_census(
            catalog, &sessions, identifier,
        )?),
        1 => {
            let descriptor = ready_named.remove(0);
            catalog
                .open(&SessionSelector::new(
                    descriptor.session_id,
                    Some(descriptor.workspace_id),
                ))
                .map_err(|error| Box::new(error) as Box<dyn std::error::Error>)
        }
        count => Err(Box::new(CliError(format!(
            "Hmux name `{identifier}` matches {count} running standalone sessions"
        )))),
    }
}

fn require_standalone(session: LocalSession) -> Result<LocalSession, Box<dyn std::error::Error>> {
    if session.descriptor().session_class != SessionClass::Standalone {
        return Err(Box::new(CliError(format!(
            "{} is a managed session; use its daemon-authorized attach path",
            session.descriptor().session_id
        ))));
    }
    Ok(session)
}

/// Only a foreground *attach* nests badly inside an existing Hmux session: two
/// attach layers would fight over keystrokes, escape sequences (synchronized
/// output, the `Ctrl-\ d` detach key) and canonical geometry. Detached creation
/// (`hmux new`/`restore`/`upgrade` without `--foreground`) takes over no
/// terminal, so it is safe to run from inside a session.
fn should_refuse_nested_attach(inside_hmux_session: bool, foreground_attach: bool) -> bool {
    inside_hmux_session && foreground_attach
}

fn refuse_nested_attach(foreground_attach: bool) -> Result<(), CliError> {
    if should_refuse_nested_attach(std::env::var_os("HMUX").is_some(), foreground_attach) {
        return Err(CliError(
            "cannot attach from inside an Hmux session; detach first (Ctrl-\\ then d) or run from a terminal that is not inside a session".into(),
        ));
    }
    Ok(())
}

fn attach_foreground(
    session: &LocalSession,
    read_only: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    if !read_only {
        return managed_attach::attach_standalone(session.clone());
    }
    let mut connection = session.connect(LocalAttachRole::Observer, None)?;
    let initial_repaint = connection.require_initial_snapshot()?.repaint_bytes.clone();
    let display_name = session
        .descriptor()
        .session_name
        .as_deref()
        .unwrap_or("shell")
        .to_string();
    terminal_attach_ui::write_terminal_repaint(&display_name, &initial_repaint, false)?;
    read_terminal_updates(&mut connection, &display_name)
}

fn read_terminal_updates(
    connection: &mut LocalConnection,
    display_name: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    loop {
        match connection.read_body() {
            Ok(FrameBody::OutputDelta(delta)) => {
                terminal_attach_ui::write_terminal_delta(display_name, &delta.bytes)?;
            }
            Ok(FrameBody::ScreenSnapshot(snapshot)) => {
                terminal_attach_ui::write_terminal_repaint(
                    display_name,
                    &snapshot.repaint_bytes,
                    false,
                )?;
            }
            Ok(FrameBody::Exit(_)) => break,
            Ok(FrameBody::Error(error)) => {
                return Err(Box::new(CliError(error.message)));
            }
            Ok(_) => {}
            Err(error) if error.code() == "hmux_transport_closed" => break,
            Err(error) => return Err(Box::new(error)),
        }
    }
    connection.shutdown();
    Ok(())
}

fn encode_send_keys(keys: &[String], literal: bool) -> Result<Vec<u8>, CliError> {
    let mut bytes = Vec::new();
    for key in keys {
        if literal {
            bytes.extend_from_slice(key.as_bytes());
            continue;
        }
        match key.as_str() {
            "Enter" | "Return" => bytes.push(b'\r'),
            "Tab" => bytes.push(b'\t'),
            "Space" => bytes.push(b' '),
            "Escape" | "Esc" => bytes.push(0x1b),
            "BSpace" | "Backspace" => bytes.push(0x7f),
            "Up" | "ArrowUp" => bytes.extend_from_slice(b"\x1b[A"),
            "Down" | "ArrowDown" => bytes.extend_from_slice(b"\x1b[B"),
            "Right" | "ArrowRight" => bytes.extend_from_slice(b"\x1b[C"),
            "Left" | "ArrowLeft" => bytes.extend_from_slice(b"\x1b[D"),
            "Home" => bytes.extend_from_slice(b"\x1b[H"),
            "End" => bytes.extend_from_slice(b"\x1b[F"),
            "PageUp" | "PgUp" => bytes.extend_from_slice(b"\x1b[5~"),
            "PageDown" | "PgDn" => bytes.extend_from_slice(b"\x1b[6~"),
            "Delete" | "DC" => bytes.extend_from_slice(b"\x1b[3~"),
            "Insert" | "IC" => bytes.extend_from_slice(b"\x1b[2~"),
            "F1" => bytes.extend_from_slice(b"\x1bOP"),
            "F2" => bytes.extend_from_slice(b"\x1bOQ"),
            "F3" => bytes.extend_from_slice(b"\x1bOR"),
            "F4" => bytes.extend_from_slice(b"\x1bOS"),
            "F5" => bytes.extend_from_slice(b"\x1b[15~"),
            "F6" => bytes.extend_from_slice(b"\x1b[17~"),
            "F7" => bytes.extend_from_slice(b"\x1b[18~"),
            "F8" => bytes.extend_from_slice(b"\x1b[19~"),
            "F9" => bytes.extend_from_slice(b"\x1b[20~"),
            "F10" => bytes.extend_from_slice(b"\x1b[21~"),
            "F11" => bytes.extend_from_slice(b"\x1b[23~"),
            "F12" => bytes.extend_from_slice(b"\x1b[24~"),
            value if value.len() == 3 && value.starts_with("C-") => {
                let byte = value.as_bytes()[2];
                if !byte.is_ascii() {
                    return Err(CliError(format!("unsupported control key `{value}`")));
                }
                bytes.push(if byte == b'?' {
                    0x7f
                } else {
                    byte.to_ascii_uppercase() & 0x1f
                });
            }
            value => bytes.extend_from_slice(value.as_bytes()),
        }
    }
    if bytes.is_empty() {
        return Err(CliError(
            "send-keys requires at least one non-empty key".into(),
        ));
    }
    Ok(bytes)
}

fn filter_sessions(
    sessions: Vec<SessionDescriptor>,
    filter: Option<SessionClassFilter>,
) -> Vec<SessionDescriptor> {
    sessions
        .into_iter()
        .filter(|session| match filter {
            None => true,
            Some(SessionClassFilter::Managed) => session.session_class == SessionClass::Managed,
            Some(SessionClassFilter::Standalone) => {
                session.session_class == SessionClass::Standalone
            }
        })
        .collect()
}

/// A recipe is keyed by session name, so an unnamed session can never have one.
fn session_liveness_for(
    session: &SessionDescriptor,
    probe: Option<SessionProbeStatus>,
    discovery_root: &Path,
) -> SessionLiveness {
    let automatic_recovery_supported =
        session.session_class == SessionClass::Standalone && session.provider_id == "local-shell";
    let recipe = automatic_recovery_supported
        .then(|| {
            session.session_name.as_deref().and_then(|name| {
                resurrection::resolve_if_saved(discovery_root, name)
                    .ok()
                    .flatten()
            })
        })
        .flatten();
    project_session_liveness(SessionLivenessInput {
        lifecycle: session.lifecycle,
        automatic_recovery_supported,
        verified_recipe: recipe.is_some(),
        replays_explicit_command: recipe.is_some_and(|recipe| {
            recipe.resurrection_replay_policy()
                == StandaloneResurrectionReplayPolicy::ConfirmExplicitCommand
        }),
        probe,
    })
}

#[derive(serde::Serialize)]
struct SessionWithLiveness<'a> {
    #[serde(flatten)]
    session: &'a SessionInspection,
    /// Whether attaching resumes, restarts, or fails. 현재 상태 자체는
    /// effectiveLifecycle/health가 이미 낸다 — 같은 사실을 두 이름으로 내면
    /// 언젠가 서로 어긋난다.
    recoverability: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    recoverability_reason: Option<&'static str>,
}

fn sessions_with_liveness<'a>(
    sessions: &'a [SessionInspection],
    liveness: &[SessionLiveness],
) -> Vec<SessionWithLiveness<'a>> {
    sessions
        .iter()
        .enumerate()
        .map(|(index, session)| {
            let projected = liveness.get(index).copied().unwrap_or(SessionLiveness {
                state: LivenessState::Unprobed,
                recoverability: Recoverability::Unknown,
            });
            SessionWithLiveness {
                session,
                recoverability: recoverability_name(projected.recoverability),
                recoverability_reason: match projected.recoverability {
                    Recoverability::Unrecoverable { reason } => Some(reason),
                    _ => None,
                },
            }
        })
        .collect()
}

#[derive(Clone, Copy)]
struct BoundedCatalogOutputMetadata {
    complete: bool,
    prioritized_items: usize,
    omitted_count: usize,
    max_output_bytes: usize,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BoundedCatalogTruncation {
    items: bool,
    omitted_count: usize,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BoundedSessionCatalog<'a> {
    schema_version: u16,
    complete: bool,
    prioritized_items: usize,
    sessions: Vec<SessionWithLiveness<'a>>,
    truncation: BoundedCatalogTruncation,
}

fn serialize_bounded_session_catalog(
    sessions: &[SessionInspection],
    liveness: &[SessionLiveness],
    metadata: BoundedCatalogOutputMetadata,
) -> Result<String, CliError> {
    let original_items = sessions.len();
    let total_items = original_items.saturating_add(metadata.omitted_count);
    let mut included_items = original_items;
    loop {
        let omitted_count = total_items.saturating_sub(included_items);
        let document = BoundedSessionCatalog {
            schema_version: SESSION_CATALOG_QUERY_SCHEMA_VERSION,
            complete: metadata.complete,
            prioritized_items: metadata.prioritized_items,
            sessions: sessions_with_liveness(
                &sessions[..included_items],
                &liveness[..included_items.min(liveness.len())],
            ),
            truncation: BoundedCatalogTruncation {
                items: omitted_count > 0,
                omitted_count,
            },
        };
        let serialized = serde_json::to_string(&document).map_err(|_| {
            CliError("hmux_session_catalog_query_failed: serialization failed".into())
        })?;
        if serialized.len().saturating_add(1) <= metadata.max_output_bytes {
            return Ok(serialized);
        }
        if included_items <= metadata.prioritized_items {
            let message = if metadata.prioritized_items > 0 {
                "hmux_session_catalog_priority_output_limit: prioritized descriptors exceed the byte budget"
            } else {
                "hmux_session_catalog_output_limit: catalog envelope exceeds the byte budget"
            };
            return Err(CliError(message.into()));
        }
        included_items -= 1;
    }
}

fn render_sessions(sessions: &[SessionInspection], liveness: &[SessionLiveness]) -> String {
    if sessions.is_empty() {
        return "No Hmux sessions.\n".into();
    }
    let mut output = String::from("NAME\tID\tCLASS\tSTATE\tLIVE\tRECOVERY\tPID\n");
    for (index, session) in sessions.iter().enumerate() {
        let projected = liveness.get(index).copied().unwrap_or(SessionLiveness {
            state: LivenessState::Unprobed,
            recoverability: Recoverability::Unknown,
        });
        output.push_str(&format!(
            "{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
            session.session_name.as_deref().unwrap_or("-"),
            short_session_id(&session.session_id),
            class_name(session.session_class),
            lifecycle_name(session.lifecycle),
            effective_lifecycle_name(session.effective_lifecycle),
            match projected.recoverability {
                Recoverability::Unrecoverable { reason } => reason,
                other => recoverability_name(other),
            },
            session.host_process.process_id,
        ));
    }
    output
}

fn render_session(session: &SessionInspection) -> String {
    format!(
        concat!(
            "session: {}\n",
            "name: {}\n",
            "workspace: {}\n",
            "class: {}\n",
            "state: {}\n",
            "manifest state: {}\n",
            "health: {}\n",
            "provider: {}\n",
            "runtime host: {}\n",
            "host instance: {}\n",
            "terminal epoch: {}\n",
            "output sequence: {}\n",
            "controller input pending: {}\n",
            "host pid: {}\n",
            "provider pid: {}\n",
            "protocol: {}.{}-{}.{}\n",
            "capabilities: {}\n",
        ),
        session.session_id,
        session.session_name.as_deref().unwrap_or("-"),
        session.workspace_id,
        class_name(session.session_class),
        effective_lifecycle_name(session.effective_lifecycle),
        lifecycle_name(session.manifest_lifecycle),
        health_name(session.health),
        session.provider_id,
        session.runtime_host.as_deref().unwrap_or("local"),
        session.host_instance_id,
        session.terminal_epoch,
        session.output_seq,
        match session.controller_input_pending {
            Some(true) => "yes",
            Some(false) => "no",
            None => "unknown",
        },
        session.host_process.process_id,
        session.provider_process.process_id,
        session.supported_protocol.minimum.major,
        session.supported_protocol.minimum.minor,
        session.supported_protocol.maximum.major,
        session.supported_protocol.maximum.minor,
        session.capabilities.join(","),
    )
}

fn short_session_id(session_id: &str) -> String {
    session_id
        .strip_prefix("standalone_")
        .unwrap_or(session_id)
        .chars()
        .take(8)
        .collect()
}

fn class_name(class: SessionClass) -> &'static str {
    match class {
        SessionClass::Managed => "managed",
        SessionClass::Standalone => "standalone",
    }
}

fn lifecycle_name(lifecycle: SessionLifecycle) -> &'static str {
    match lifecycle {
        SessionLifecycle::Ready => "ready",
        SessionLifecycle::Exited => "exited",
    }
}

fn effective_lifecycle_name(lifecycle: SessionEffectiveLifecycle) -> &'static str {
    match lifecycle {
        SessionEffectiveLifecycle::Ready => "ready",
        SessionEffectiveLifecycle::Stale => "stale",
        SessionEffectiveLifecycle::Incompatible => "incompatible",
        SessionEffectiveLifecycle::Exited => "exited",
        SessionEffectiveLifecycle::Unprobed => "unprobed",
    }
}

fn health_name(health: SessionHealth) -> &'static str {
    match health {
        SessionHealth::Healthy => "healthy",
        SessionHealth::StaleTransport => "stale_transport",
        SessionHealth::IncompatibleProtocol => "incompatible_protocol",
        SessionHealth::Exited => "exited",
        SessionHealth::GenerationChanged => "generation_changed",
        SessionHealth::Unprobed => "unprobed",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hmux_client::{
        EndpointDescriptor, EndpointKind, ProcessDescriptor, ProtocolVersion, VersionRange,
    };

    #[test]
    fn nested_guard_blocks_only_foreground_attach() {
        // Inside a session, a foreground attach nests badly and is refused.
        assert!(should_refuse_nested_attach(true, true));
        // Inside a session, detached creation (`hmux new`/`restore`/`upgrade`
        // without `--foreground`) takes over no terminal, so it is allowed.
        assert!(!should_refuse_nested_attach(true, false));
        // Outside any session, nothing is refused.
        assert!(!should_refuse_nested_attach(false, true));
        assert!(!should_refuse_nested_attach(false, false));
    }

    fn descriptor() -> SessionDescriptor {
        SessionDescriptor {
            launch_program: None,
            schema_version: 1,
            session_id: "standalone_99684cadcecb4353".into(),
            session_name: Some("dev".into()),
            workspace_id: "workspace-1".into(),
            session_class: SessionClass::Standalone,
            lifecycle: SessionLifecycle::Ready,
            provider_id: "shell".into(),
            runtime_host: Some("rts".into()),
            worktree_alias: None,
            branch: None,
            runner_principal: "local-user".into(),
            runner_instance: "runner-1".into(),
            channel_epoch: "1".into(),
            host_instance_id: "host-1".into(),
            terminal_epoch: "terminal-1".into(),
            output_seq: "8".into(),
            host_build_version: "build-1".into(),
            supported_protocol: VersionRange {
                minimum: ProtocolVersion { major: 1, minor: 0 },
                maximum: ProtocolVersion { major: 1, minor: 0 },
            },
            capabilities: vec!["screen_snapshot".into()],
            retirement_policy: None,
            host_process: ProcessDescriptor {
                process_id: 100,
                start_marker: "host-start".into(),
            },
            provider_process: ProcessDescriptor {
                process_id: 101,
                start_marker: "provider-start".into(),
            },
            endpoint: EndpointDescriptor {
                kind: EndpointKind::UnixSocket,
                address: "host.sock".into(),
            },
            created_unix_ms: "1".into(),
            lifecycle_changed_unix_ms: "2".into(),
            exit: None,
            failure: None,
        }
    }

    #[test]
    fn parses_the_hidden_provider_neutral_command_bridge() {
        let cli = Cli::try_parse_from([
            "hmux",
            "command-bridge",
            "--bridge-dir",
            "/tmp/private-bridge",
            "--bridge-nonce",
            "bridge-1",
            "--provider-id",
            "codex",
            "--executable",
            "codex",
            "--",
            "--version",
        ])
        .unwrap();
        let Command::ProviderBridge(args) = cli.command else {
            panic!("expected hidden command bridge")
        };
        assert_eq!(args.bridge_dir, PathBuf::from("/tmp/private-bridge"));
        assert_eq!(args.bridge_nonce, "bridge-1");
        assert_eq!(args.provider_id, "codex");
        assert_eq!(args.executable, "codex");
        assert_eq!(args.arguments, ["--version"]);
    }

    #[test]
    fn parses_daemon_independent_managed_rehost_without_a_launch_recipe_hint() {
        let fence = serde_json::json!({
            "runnerPrincipal": "principal-1",
            "runnerInstance": "runner-1",
            "channelEpoch": 7,
            "hostInstanceId": "host-1",
            "terminalEpoch": "terminal-1"
        })
        .to_string();
        let cli = Cli::try_parse_from([
            "hmux",
            "--json",
            "managed-rehost",
            "--session",
            "source-1",
            "--workspace",
            "workspace-1",
            "--expected-fence-json",
            &fence,
            "--operation-id",
            "operation-1",
            "--confirm-restart",
            "--expected-provider",
            "codex",
            "--expected-conversation",
            "conversation-1",
            "--expected-launch-reference",
            "credential-reference-1",
        ])
        .unwrap();
        assert!(cli.json);
        let Command::ManagedRehost(args) = cli.command else {
            panic!("expected managed rehost")
        };
        assert_eq!(args.session, "source-1");
        assert_eq!(args.workspace, "workspace-1");
        assert_eq!(args.operation_id, "operation-1");
        assert!(args.confirm_restart);
        assert_eq!(args.expected_provider.as_deref(), Some("codex"));
        assert_eq!(
            args.expected_conversation.as_deref(),
            Some("conversation-1")
        );
        assert_eq!(
            args.expected_launch_reference.as_deref(),
            Some("credential-reference-1")
        );
    }

    #[test]
    fn parses_backend_owned_managed_rehost_resolution() {
        let cli = Cli::try_parse_from([
            "hmux",
            "--json",
            "managed-rehost-resolve",
            "--session",
            "source-1",
            "--workspace",
            "workspace-1",
        ])
        .unwrap();
        assert!(cli.json);
        let Command::ManagedRehostResolve(args) = cli.command else {
            panic!("expected managed rehost resolution")
        };
        assert_eq!(args.source.session.as_deref(), Some("source-1"));
        assert_eq!(args.source.workspace.as_deref(), Some("workspace-1"));
    }

    #[test]
    fn managed_rehost_json_error_spelling_is_stable() {
        let payload = managed_rehost_error_json(&ClientError::InvalidDiscoveryRoot);
        assert_eq!(payload["schema"], "hmux-managed-rehost-v1");
        assert_eq!(payload["schemaVersion"], 1);
        assert_eq!(payload["state"], "refused");
        assert_eq!(payload["error"]["code"], "hmux_discovery_root_invalid");
        assert!(payload["error"]["message"].is_string());
    }

    #[test]
    fn command_bridge_marker_contains_only_the_exact_public_runtime_fence() {
        let mut target = descriptor();
        target.session_id = "managed-target".into();
        target.workspace_id = "managed-workspace".into();
        target.session_class = SessionClass::Managed;
        target.provider_id = "codex".into();
        let encoded = encode_command_bridge_marker(
            "bridge-1",
            "standalone-source",
            "standalone-workspace",
            &target,
        )
        .unwrap();
        let payload = encoded
            .strip_prefix("\u{1b}]778;dure-hmux-command-bridge-v1;")
            .and_then(|value| value.strip_suffix('\u{7}'))
            .unwrap();
        let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(payload)
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&decoded).unwrap();
        assert_eq!(value["event"], "managed_started");
        assert_eq!(value["sourceSessionId"], "standalone-source");
        assert_eq!(value["target"]["sessionId"], "managed-target");
        assert_eq!(value["target"]["sessionClass"], "managed");
        let serialized = value.to_string();
        assert!(!serialized.contains("token"));
        assert!(!serialized.contains("credential"));
        assert!(!serialized.contains("proof"));
    }

    #[test]
    fn parses_tmux_attach_alias_and_target_flag() {
        let cli = Cli::try_parse_from(["hmux", "a", "-t", "dev"]).unwrap();
        let Command::Attach(args) = cli.command else {
            panic!("expected attach")
        };
        assert_eq!(args.identifier().unwrap(), "dev");
    }

    #[test]
    fn parses_exact_local_and_remote_managed_attach_commands() {
        let cli = Cli::try_parse_from([
            "hmux",
            "managed-attach",
            "session-1",
            "--workspace",
            "workspace-1",
        ])
        .unwrap();
        let Command::ManagedAttach(args) = cli.command else {
            panic!("expected managed attach")
        };
        assert_eq!(args.session, "session-1");
        assert_eq!(args.workspace, "workspace-1");

        let cli = Cli::try_parse_from([
            "hmux",
            "remote-managed-attach",
            "session-1",
            "--workspace",
            "workspace-1",
            "--host",
            "server.example",
            "--port",
            "2222",
            "--user",
            "developer",
            "--connect-timeout-ms",
            "1000",
            "--identity-file",
            "/private/key",
            "--known-hosts-file",
            "/private/known_hosts",
            "--expected-fence-json",
            "{}",
        ])
        .unwrap();
        let Command::RemoteManagedAttach(args) = cli.command else {
            panic!("expected remote managed attach")
        };
        assert_eq!(args.session, "session-1");
        assert_eq!(args.workspace, "workspace-1");
        assert_eq!(args.port, 2222);
        assert_eq!(args.connect_timeout_ms, 1000);
        assert_eq!(args.identity_file, Some(PathBuf::from("/private/key")));
        assert!(!args.ssh_agent);
        assert_eq!(args.expected_fence_json, "{}");

        let cli = Cli::try_parse_from([
            "hmux",
            "remote-managed-attach",
            "session-1",
            "--workspace",
            "workspace-1",
            "--host",
            "server.example",
            "--port",
            "2222",
            "--user",
            "developer",
            "--connect-timeout-ms",
            "1000",
            "--ssh-agent",
            "--known-hosts-file",
            "/private/known_hosts",
            "--expected-fence-json",
            "{}",
        ])
        .unwrap();
        let Command::RemoteManagedAttach(args) = cli.command else {
            panic!("expected remote managed attach")
        };
        assert!(args.identity_file.is_none());
        assert!(args.ssh_agent);
    }

    #[test]
    fn parses_and_enforces_a_generation_fenced_kill() {
        let descriptor = descriptor();
        let expected = SessionFence {
            workspace_id: descriptor.workspace_id.clone(),
            session_id: descriptor.session_id.clone(),
            runner_principal: descriptor.runner_principal.clone(),
            runner_instance: descriptor.runner_instance.clone(),
            channel_epoch: descriptor.channel_epoch.parse().unwrap(),
            host_instance_id: descriptor.host_instance_id.clone(),
            terminal_epoch: descriptor.terminal_epoch.clone(),
        };
        let expected_json = serde_json::to_string(&expected).unwrap();
        let cli = Cli::try_parse_from([
            "hmux",
            "kill",
            "dev",
            "--workspace",
            "workspace-1",
            "--expected-fence-json",
            expected_json.as_str(),
            "--runtime",
            "/tmp/hmux-runtime",
        ])
        .unwrap();
        let Command::Kill(args) = cli.command else {
            panic!("expected kill")
        };
        assert_eq!(args.workspace.as_deref(), Some("workspace-1"));
        assert_eq!(args.runtime, Some(PathBuf::from("/tmp/hmux-runtime")));
        let parsed = parse_expected_fence(args.expected_fence_json.as_deref().unwrap()).unwrap();
        ensure_expected_fence(&descriptor, &parsed).unwrap();

        let replacement = SessionFence {
            terminal_epoch: "terminal-replacement".into(),
            ..expected
        };
        assert!(
            ensure_expected_fence(&descriptor, &replacement)
                .unwrap_err()
                .0
                .starts_with("hmux_expected_generation_mismatch:")
        );
    }

    #[test]
    fn parses_generation_fenced_managed_send_keys() {
        let descriptor = descriptor();
        let expected = SessionFence {
            workspace_id: descriptor.workspace_id.clone(),
            session_id: descriptor.session_id.clone(),
            runner_principal: descriptor.runner_principal.clone(),
            runner_instance: descriptor.runner_instance.clone(),
            channel_epoch: descriptor.channel_epoch.parse().unwrap(),
            host_instance_id: descriptor.host_instance_id.clone(),
            terminal_epoch: descriptor.terminal_epoch.clone(),
        };
        let expected_json = serde_json::to_string(&expected).unwrap();
        let cli = Cli::try_parse_from([
            "hmux",
            "--json",
            "send-keys",
            "--target",
            descriptor.session_id.as_str(),
            "--workspace",
            descriptor.workspace_id.as_str(),
            "--expected-fence-json",
            expected_json.as_str(),
            "--literal",
            "status\r",
        ])
        .unwrap();
        assert!(cli.json);
        let Command::SendKeys(args) = cli.command else {
            panic!("expected send-keys")
        };
        assert_eq!(args.workspace.as_deref(), Some("workspace-1"));
        assert_eq!(args.keys, vec!["status\r"]);
        let parsed = parse_expected_fence(args.expected_fence_json.as_deref().unwrap()).unwrap();
        ensure_expected_fence(&descriptor, &parsed).unwrap();
    }

    #[test]
    fn parses_semantic_named_key_batch() {
        let parsed = Cli::try_parse_from([
            "hmux",
            "command-input",
            "--target",
            "session-1",
            "--key",
            "C-c",
            "--key",
            "Up",
            "--key",
            "Enter",
        ]);
        assert!(
            parsed.is_ok(),
            "semantic named keys were rejected: {parsed:?}"
        );
        for text_option in ["--text", "--submit"] {
            let mut args = vec![
                "hmux",
                "command-input",
                "--target",
                "session-1",
                "--key",
                "Enter",
                text_option,
            ];
            if text_option == "--text" {
                args.push("literal");
            }
            assert!(
                Cli::try_parse_from(args).is_err(),
                "mixed text/key input was accepted"
            );
        }
    }

    #[test]
    fn parses_generation_fenced_semantic_command_input() {
        let descriptor = descriptor();
        let expected = SessionFence {
            workspace_id: descriptor.workspace_id.clone(),
            session_id: descriptor.session_id.clone(),
            runner_principal: descriptor.runner_principal.clone(),
            runner_instance: descriptor.runner_instance.clone(),
            channel_epoch: descriptor.channel_epoch.parse().unwrap(),
            host_instance_id: descriptor.host_instance_id.clone(),
            terminal_epoch: descriptor.terminal_epoch.clone(),
        };
        let expected_json = serde_json::to_string(&expected).unwrap();
        let cli = Cli::try_parse_from([
            "hmux",
            "--json",
            "command-input",
            "--target",
            descriptor.session_id.as_str(),
            "--workspace",
            descriptor.workspace_id.as_str(),
            "--expected-fence-json",
            expected_json.as_str(),
            "--text",
            "first\nsecond",
            "--submit",
        ])
        .unwrap();
        assert!(cli.json);
        let Command::AutomationInput(args) = cli.command else {
            panic!("expected command-input")
        };
        assert_eq!(args.text, "first\nsecond");
        assert!(args.submit);
        assert_eq!(args.workspace.as_deref(), Some("workspace-1"));
        let parsed = parse_expected_fence(args.expected_fence_json.as_deref().unwrap()).unwrap();
        ensure_expected_fence(&descriptor, &parsed).unwrap();
    }

    #[test]
    fn parses_generation_fenced_managed_resize() {
        let descriptor = descriptor();
        let expected = SessionFence {
            workspace_id: descriptor.workspace_id.clone(),
            session_id: descriptor.session_id.clone(),
            runner_principal: descriptor.runner_principal.clone(),
            runner_instance: descriptor.runner_instance.clone(),
            channel_epoch: descriptor.channel_epoch.parse().unwrap(),
            host_instance_id: descriptor.host_instance_id.clone(),
            terminal_epoch: descriptor.terminal_epoch.clone(),
        };
        let expected_json = serde_json::to_string(&expected).unwrap();
        let cli = Cli::try_parse_from([
            "hmux",
            "--json",
            "resize",
            "--target",
            descriptor.session_id.as_str(),
            "--workspace",
            descriptor.workspace_id.as_str(),
            "--expected-fence-json",
            expected_json.as_str(),
            "--columns",
            "132",
            "--rows",
            "41",
        ])
        .unwrap();
        assert!(cli.json);
        let Command::Resize(args) = cli.command else {
            panic!("expected resize")
        };
        assert_eq!(args.workspace.as_deref(), Some("workspace-1"));
        assert_eq!((args.columns, args.rows), (132, 41));
        let parsed = parse_expected_fence(args.expected_fence_json.as_deref().unwrap()).unwrap();
        ensure_expected_fence(&descriptor, &parsed).unwrap();
    }

    #[test]
    fn expected_fence_json_requires_a_lossless_channel_epoch_string() {
        let canonical = r#"{"workspace_id":"workspace-1","session_id":"session-1","runner_principal":"runner-principal-1","runner_instance":"runner-instance-1","channel_epoch":"18446744073709551615","host_instance_id":"host-instance-1","terminal_epoch":"terminal-epoch-1"}"#;
        assert_eq!(
            parse_expected_fence(canonical).unwrap().channel_epoch,
            u64::MAX
        );

        let numeric = canonical.replace(
            r#""channel_epoch":"18446744073709551615""#,
            r#""channel_epoch":18446744073709551615"#,
        );
        assert!(parse_expected_fence(&numeric).is_err());
    }

    #[test]
    fn a_forced_command_gateway_parses_with_no_arguments_at_all() {
        // The contract this replaced required `--session` unless `--list` was
        // present, and that made the one key `hmux pair` installs dead on
        // arrival: a forced command replaces the client's argv, so a phone can
        // append neither flag and every connection exited 2 with "the following
        // required arguments were not provided: --session <SESSION>". The bare
        // invocation is now the *default* forced command, so it must parse.
        let cli = Cli::try_parse_from(["hmux", "mobile-gateway"])
            .expect("the default forced command must parse, or pairing installs a dead key");
        let Command::MobileGateway(args) = cli.command else {
            panic!("expected mobile-gateway")
        };
        assert!(
            args.session.is_none(),
            "no pin means the relayed Hello names the session"
        );
        assert!(!args.list);
        // The scoping that remains is the ceiling, and its default is the weaker
        // one: a forced command that forgets `--role` must not hand out control.
        assert_eq!(args.role, mobile_gateway::GatewayRole::Observer);

        // A role without a session is now a legal, deliberate line: it is how an
        // operator authorizes a phone to type into whichever session it picks.
        // What it is not is an accident — `--role controller` has to be written.
        let cli = Cli::try_parse_from(["hmux", "mobile-gateway", "--role", "controller"])
            .expect("an unpinned controller gateway is a supported forced command");
        let Command::MobileGateway(args) = cli.command else {
            panic!("expected mobile-gateway")
        };
        assert!(args.session.is_none());
        assert_eq!(args.role, mobile_gateway::GatewayRole::Controller);
    }

    #[test]
    fn a_pinned_session_survives_as_the_narrow_escape_hatch() {
        // Optional must not mean gone. An operator who wants a key that reaches
        // exactly one session still writes `--session`, and the parse has to
        // carry it through to the constraint `admit_relayed_hello` enforces.
        let cli = Cli::try_parse_from([
            "hmux",
            "mobile-gateway",
            "--session",
            "dev",
            "--workspace",
            "ws-1",
            "--role",
            "observer",
        ])
        .unwrap();
        let Command::MobileGateway(args) = cli.command else {
            panic!("expected mobile-gateway")
        };
        assert_eq!(args.session.as_deref(), Some("dev"));
        assert_eq!(args.workspace.as_deref(), Some("ws-1"));
        assert_eq!(args.role, mobile_gateway::GatewayRole::Observer);
        assert!(!args.list);
    }

    #[test]
    fn a_listing_gateway_may_be_scoped_or_unscoped() {
        // Scoped: the same forced-command line with `--list` appended, which is
        // how an operator narrows a listing to the one session they granted.
        let cli =
            Cli::try_parse_from(["hmux", "mobile-gateway", "--session", "dev", "--list"]).unwrap();
        let Command::MobileGateway(args) = cli.command else {
            panic!("expected mobile-gateway")
        };
        assert!(args.list);
        assert_eq!(args.session.as_deref(), Some("dev"));
        // Unscoped: allowed, because an operator who writes `--list` alone has
        // chosen to expose this account's catalog.
        let cli = Cli::try_parse_from(["hmux", "mobile-gateway", "--list"]).unwrap();
        let Command::MobileGateway(args) = cli.command else {
            panic!("expected mobile-gateway")
        };
        assert!(args.list);
        assert!(args.session.is_none());
        // The default ceiling is the weaker one. A forced command that forgets
        // `--role` must not hand out control.
        assert_eq!(args.role, mobile_gateway::GatewayRole::Observer);
    }

    #[test]
    fn parses_machine_readable_cli_capability_probe() {
        let cli = Cli::try_parse_from(["hmux", "capabilities", "--json"]).unwrap();
        assert!(cli.json);
        assert!(matches!(cli.command, Command::Capabilities));
        assert!(CLI_CAPABILITIES.contains(&"session_inspection_v1"));
        assert!(CLI_CAPABILITIES.contains(&"session_probe_status_v1"));
        assert!(CLI_CAPABILITIES.contains(&"exact_session_probe_batch_v1"));
        assert!(CLI_CAPABILITIES.contains(&"generation_fenced_kill_v1"));
        assert!(CLI_CAPABILITIES.contains(&"managed_generation_fenced_kill_v1"));
        assert!(CLI_CAPABILITIES.contains(&"managed_rehost_exact_fence_v1"));
        assert!(CLI_CAPABILITIES.contains(&"managed_rehost_resolution_v1"));
        assert!(CLI_CAPABILITIES.contains(&"semantic_command_input_v1"));
        assert!(CLI_CAPABILITIES.contains(&"pairing_v1"));
        assert!(CLI_CAPABILITIES.contains(&"pairing_revoke_inventory_v1"));
        #[cfg(unix)]
        {
            assert!(CLI_CAPABILITIES.contains(&"managed_interactive_attach_v1"));
            assert!(CLI_CAPABILITIES.contains(&"ssh_managed_interactive_attach_v1"));
            assert!(CLI_CAPABILITIES.contains(&"local_state_gc_v1"));
            assert!(CLI_CAPABILITIES.contains(&"local_state_gc_all_eligible_v1"));
            assert!(CLI_CAPABILITIES.contains(&"local_state_doctor_v1"));
            assert!(CLI_CAPABILITIES.contains(&"process_generation_probe_v1"));
            assert!(CLI_CAPABILITIES.contains(&"exited_session_cleanup_v1"));
        }
        #[cfg(not(unix))]
        {
            assert!(!CLI_CAPABILITIES.contains(&"managed_interactive_attach_v1"));
            assert!(!CLI_CAPABILITIES.contains(&"ssh_managed_interactive_attach_v1"));
            assert!(!CLI_CAPABILITIES.contains(&"local_state_gc_v1"));
            assert!(!CLI_CAPABILITIES.contains(&"local_state_gc_all_eligible_v1"));
            assert!(!CLI_CAPABILITIES.contains(&"local_state_doctor_v1"));
            assert!(!CLI_CAPABILITIES.contains(&"exited_session_cleanup_v1"));
        }
        assert!(CLI_CAPABILITIES.contains(&"session_liveness_v1"));
        assert!(CLI_CAPABILITIES.contains(&"bounded_discovery_census_v1"));
        assert!(CLI_CAPABILITIES.contains(&"session_retirement_v1"));
        #[cfg(unix)]
        assert!(CLI_CAPABILITIES.contains(&standalone_create_operation::CAPABILITY));
        #[cfg(unix)]
        assert!(CLI_CAPABILITIES.contains(&standalone_create_operation::RECONCILE_CAPABILITY));
        #[cfg(unix)]
        assert!(CLI_CAPABILITIES.contains(&standalone_create_operation::RETIRE_CAPABILITY));
        #[cfg(unix)]
        assert!(CLI_CAPABILITIES.contains(&standalone_create_operation::ACKNOWLEDGE_CAPABILITY));
        #[cfg(not(unix))]
        assert!(!CLI_CAPABILITIES.contains(&"standalone_create_operation_v1"));
        #[cfg(not(unix))]
        assert!(!CLI_CAPABILITIES.contains(&"standalone_create_operation_reconcile_v1"));
        #[cfg(not(unix))]
        assert!(
            !CLI_CAPABILITIES.contains(&"standalone_create_operation_retire_completed_target_v1")
        );
        #[cfg(not(unix))]
        assert!(
            !CLI_CAPABILITIES.contains(&"standalone_create_operation_retirement_acknowledge_v1")
        );
        assert!(CLI_CAPABILITIES.contains(&runtime_status::RUNTIME_STATUS_CAPABILITY));
    }

    #[test]
    fn parses_bounded_runtime_status() {
        let cli = Cli::try_parse_from([
            "hmux",
            "runtime",
            "status",
            "--probe-budget-ms",
            "200",
            "--json",
        ])
        .unwrap();
        let Command::Runtime {
            command: RuntimeCommand::Status(args),
        } = cli.command
        else {
            panic!("expected runtime status")
        };
        assert_eq!(args.probe_budget_ms, Some(200));
        assert!(cli.json);

        let cli = Cli::try_parse_from(["hmux", "runtime", "status"]).unwrap();
        let Command::Runtime {
            command: RuntimeCommand::Status(args),
        } = cli.command
        else {
            panic!("expected runtime status")
        };
        assert_eq!(args.probe_budget_ms, None);
    }

    #[test]
    #[cfg(unix)]
    fn exact_process_generation_probe_preserves_the_complete_marker() {
        let cli = Cli::try_parse_from([
            "hmux",
            "--json",
            "process",
            "probe",
            "4242",
            "4242-1700000000000",
        ])
        .unwrap();
        assert!(cli.json);
        let Command::Process {
            command:
                ProcessInspectionCommand::Probe {
                    process_id,
                    start_marker,
                },
        } = cli.command
        else {
            panic!("expected process probe")
        };
        assert_eq!(process_id, 4242);
        assert_eq!(start_marker, "4242-1700000000000");
    }

    #[test]
    fn retirement_sweep_is_preview_unless_apply_is_explicit() {
        let preview =
            Cli::try_parse_from(["hmux", "session", "retirement", "sweep", "dev"]).unwrap();
        let Command::Session {
            command:
                SessionCommand::Retirement {
                    command: SessionRetirementCommand::Sweep(args),
                },
        } = preview.command
        else {
            panic!("retirement sweep must parse");
        };
        assert_eq!(args.session.as_deref(), Some("dev"));
        assert!(!args.apply);

        let apply = Cli::try_parse_from([
            "hmux",
            "session",
            "retirement",
            "sweep",
            "session-1",
            "--workspace",
            "workspace-1",
            "--apply",
        ])
        .unwrap();
        let Command::Session {
            command:
                SessionCommand::Retirement {
                    command: SessionRetirementCommand::Sweep(args),
                },
        } = apply.command
        else {
            panic!("retirement apply must parse");
        };
        assert_eq!(args.session.as_deref(), Some("session-1"));
        assert_eq!(args.workspace.as_deref(), Some("workspace-1"));
        assert!(args.apply);

        let all_preview = Cli::try_parse_from(["hmux", "session", "retirement", "sweep"]).unwrap();
        let Command::Session {
            command:
                SessionCommand::Retirement {
                    command: SessionRetirementCommand::Sweep(args),
                },
        } = all_preview.command
        else {
            panic!("all-session retirement preview must parse");
        };
        assert!(args.session.is_none());
        assert!(!args.apply);

        let all_apply =
            Cli::try_parse_from(["hmux", "session", "retirement", "sweep", "--apply"]).unwrap();
        let Command::Session {
            command:
                SessionCommand::Retirement {
                    command: SessionRetirementCommand::Sweep(args),
                },
        } = all_apply.command
        else {
            panic!("all-session retirement apply must parse");
        };
        assert!(args.session.is_none());
        assert!(args.apply);
        assert!(
            Cli::try_parse_from([
                "hmux",
                "session",
                "retirement",
                "sweep",
                "--workspace",
                "workspace-1",
            ])
            .is_err()
        );
    }

    #[test]
    fn all_session_retirement_selects_ready_standalone_even_without_policy() {
        let ready_standalone = descriptor();
        assert!(ready_standalone.retirement_policy.is_none());

        let mut ready_managed = descriptor();
        ready_managed.session_id = "managed-1".into();
        ready_managed.session_class = SessionClass::Managed;

        let mut exited_standalone = descriptor();
        exited_standalone.session_id = "standalone-exited".into();
        exited_standalone.lifecycle = SessionLifecycle::Exited;

        let selection = select_retirement_sweep_candidates(vec![
            ready_managed,
            exited_standalone,
            ready_standalone.clone(),
        ]);
        assert_eq!(selection.candidates, vec![ready_standalone]);
        assert_eq!(selection.skipped_managed, 1);
        assert_eq!(selection.skipped_exited, 1);
    }

    #[test]
    fn all_session_retirement_summary_keeps_refusals_and_errors_typed() {
        let descriptor = descriptor();
        let mut summary = RetirementSweepSummary::new(true, 2, 3);
        summary.push_receipt(
            &descriptor,
            SessionRetirementReceipt {
                request_id: "request-1".into(),
                state: SessionRetirementReceiptState::Refused,
                reason: Some(SessionRetirementReceiptReason::ProviderBusy),
                policy: None,
            },
        );
        summary.push_error(&descriptor, "hmux_io_failed", "socket unavailable");

        assert!(summary.has_failures());
        assert_eq!(summary.evaluated, 2);
        assert_eq!(summary.refused, 1);
        assert_eq!(summary.errors, 1);
        let json = serde_json::to_value(&summary).unwrap();
        assert_eq!(json["mode"], "apply");
        assert_eq!(json["skippedManaged"], 2);
        assert_eq!(json["skippedExited"], 3);
        assert_eq!(json["results"][0]["outcome"], "receipt");
        assert_eq!(json["results"][0]["state"], "refused");
        assert_eq!(json["results"][1]["outcome"], "error");
        assert_eq!(json["results"][1]["code"], "hmux_io_failed");
    }

    #[test]
    fn retirement_policy_set_enforces_the_versioned_grace_bounds() {
        let set = Cli::try_parse_from([
            "hmux",
            "session",
            "retirement",
            "set",
            "dev",
            "--grace-period-ms",
            "2000",
        ])
        .unwrap();
        assert!(matches!(
            set.command,
            Command::Session {
                command: SessionCommand::Retirement {
                    command: SessionRetirementCommand::Set {
                        grace_period_ms: 2_000,
                        ..
                    }
                }
            }
        ));
        assert!(
            Cli::try_parse_from([
                "hmux",
                "session",
                "retirement",
                "set",
                "dev",
                "--grace-period-ms",
                "999",
            ])
            .is_err()
        );
    }

    #[test]
    fn cleanup_exited_is_preview_by_default_and_exact_apply_is_explicit() {
        let preview = Cli::try_parse_from(["hmux", "session", "cleanup-exited", "--json"]).unwrap();
        assert!(preview.json);
        let Command::Session {
            command: SessionCommand::CleanupExited(preview),
        } = preview.command
        else {
            panic!("cleanup-exited command must parse");
        };
        assert!(!preview.apply);
        assert!(preview.session.is_none());

        let apply = Cli::try_parse_from([
            "hmux",
            "session",
            "cleanup-exited",
            "session-1",
            "--workspace",
            "workspace-1",
            "--expected-terminal-epoch",
            "terminal-1",
            "--expected-generation-json",
            r#"{"fence":{"workspaceId":"workspace-1","sessionId":"session-1","runnerPrincipal":"runner","runnerInstance":"runner-1","channelEpoch":"1","hostInstanceId":"host-1","terminalEpoch":"terminal-1"},"hostProcess":{"processId":1,"startMarker":"start-1"}}"#,
            "--apply",
        ])
        .unwrap();
        let Command::Session {
            command: SessionCommand::CleanupExited(apply),
        } = apply.command
        else {
            panic!("cleanup-exited command must parse");
        };
        assert!(apply.apply);
        assert_eq!(apply.session.as_deref(), Some("session-1"));
        assert_eq!(apply.workspace.as_deref(), Some("workspace-1"));
        assert_eq!(apply.expected_terminal_epoch.as_deref(), Some("terminal-1"));
        assert_eq!(apply.expected_generation_json.len(), 1);

        assert!(
            Cli::try_parse_from([
                "hmux",
                "session",
                "cleanup-exited",
                "--workspace",
                "workspace-1",
            ])
            .is_err()
        );
    }

    #[test]
    #[cfg(unix)]
    fn parses_gc_as_preview_unless_apply_is_explicit() {
        let preview = Cli::try_parse_from(["hmux", "--json", "gc"]).unwrap();
        assert!(preview.json);
        let Command::Gc(preview) = preview.command else {
            panic!("gc command must parse");
        };
        assert!(!preview.apply);
        assert!(!preview.all_eligible);

        let all_eligible_preview = Cli::try_parse_from(["hmux", "gc", "--all-eligible"]).unwrap();
        let Command::Gc(all_eligible_preview) = all_eligible_preview.command else {
            panic!("gc command must parse");
        };
        assert!(!all_eligible_preview.apply);
        assert!(all_eligible_preview.all_eligible);
        assert_eq!(
            gc_policy(&all_eligible_preview).discovery.selection,
            DiscoveryGcSelection::AllEligible
        );

        let apply =
            Cli::try_parse_from(["hmux", "gc", "--apply", "--all-eligible", "--json"]).unwrap();
        assert!(apply.json);
        let Command::Gc(apply) = apply.command else {
            panic!("gc command must parse");
        };
        assert!(apply.apply);
        assert!(apply.all_eligible);
        assert_eq!(
            gc_policy(&apply).discovery.selection,
            DiscoveryGcSelection::AllEligible
        );
        assert_eq!(
            gc_policy(&GcArgs {
                apply: false,
                all_eligible: false,
            })
            .discovery
            .selection,
            DiscoveryGcSelection::Retention
        );
    }

    #[test]
    #[cfg(unix)]
    fn doctor_is_read_only_and_has_a_bounded_probe_budget() {
        let doctor = Cli::try_parse_from(["hmux", "doctor", "--probe-budget-ms", "250"]).unwrap();
        let Command::Doctor(doctor) = doctor.command else {
            panic!("doctor command must parse");
        };
        assert_eq!(doctor.probe_budget_ms, 250);
        assert!(Cli::try_parse_from(["hmux", "doctor", "--apply"]).is_err());
    }

    #[test]
    #[cfg(unix)]
    fn gc_human_and_json_reports_distinguish_planned_from_removed_journal_state() {
        use hmux_client::recovery_journal::RecoveryJournalGcReport;
        use hmux_host::local_discovery::{DiscoveryGcDiagnostic, DiscoveryGcReport};

        let preview_report = LocalStateGcReport {
            schema_version: 1,
            mode: "preview",
            discovery_selection: "retention",
            discovery_root_present: true,
            recovery_source_busy: false,
            recovery_source_locks: Default::default(),
            discovery: Some(DiscoveryGcReport::default()),
            recovery_before: None,
            recovery_gc: Some(RecoveryJournalGcReport {
                planned_completed_records: 2,
                planned_source_locks: 1,
                planned_orphan_operation_locks: 2,
                planned_temporary_files: 3,
                ..RecoveryJournalGcReport::default()
            }),
        };
        let json = serde_json::to_value(&preview_report).unwrap();
        assert_eq!(json["discoverySelection"].as_str(), Some("retention"));
        assert_eq!(
            json["recoveryGc"]["plannedCompletedRecords"].as_u64(),
            Some(2)
        );
        assert_eq!(
            json["recoveryGc"]["removedCompletedRecords"].as_u64(),
            Some(0)
        );
        let preview_lines = gc_human_lines(preview_report, false, true);
        assert!(preview_lines.iter().any(|line| {
            line == "Would remove 2 completed recovery records and 6 inactive lock/temp files."
        }));

        let apply_lines = gc_human_lines(
            LocalStateGcReport {
                schema_version: 1,
                mode: "apply",
                discovery_selection: "all_eligible",
                discovery_root_present: true,
                recovery_source_busy: false,
                recovery_source_locks: Default::default(),
                discovery: Some(DiscoveryGcReport::default()),
                recovery_before: None,
                recovery_gc: Some(RecoveryJournalGcReport {
                    removed_completed_records: 2,
                    removed_source_locks: 1,
                    removed_orphan_operation_locks: 2,
                    removed_temporary_files: 3,
                    ..RecoveryJournalGcReport::default()
                }),
            },
            true,
            true,
        );
        assert!(apply_lines.iter().any(|line| {
            line == "Removed 2 completed recovery records and 6 inactive lock/temp files."
        }));

        let incomplete_lines = gc_human_lines(
            LocalStateGcReport {
                schema_version: 1,
                mode: "apply",
                discovery_selection: "all_eligible",
                discovery_root_present: true,
                recovery_source_busy: false,
                recovery_source_locks: Default::default(),
                discovery: Some(DiscoveryGcReport {
                    remaining_state_incomplete: true,
                    budget_unmet: true,
                    diagnostics: vec![DiscoveryGcDiagnostic {
                        relative_path: "w_fixture/s_fixture".into(),
                        reason: "candidate changed or became locked before quarantine".into(),
                    }],
                    ..DiscoveryGcReport::default()
                }),
                recovery_before: None,
                recovery_gc: None,
            },
            true,
            true,
        );
        assert!(incomplete_lines.iter().any(|line| {
            line.contains("rerun with --json")
                && line.contains("retry")
                && line.contains("zero-removal convergence pass")
        }));
    }

    #[test]
    fn parses_exact_name_attach_without_an_opaque_identity() {
        let cli = Cli::try_parse_from(["hmux", "attach", "--name", "dev"]).unwrap();
        let Command::Attach(args) = cli.command else {
            panic!("expected attach")
        };
        assert_eq!(args.name.as_deref(), Some("dev"));
        assert!(args.session.is_none());
        assert!(args.target.is_none());
    }

    #[test]
    fn parses_explicit_terminal_environment_without_forcing_color() {
        let cli = Cli::try_parse_from([
            "hmux",
            "new",
            "--env",
            "NO_COLOR=1",
            "--unset-env",
            "COLORTERM",
        ])
        .unwrap();
        let Command::New(args) = cli.command else {
            panic!("expected new")
        };

        let environment =
            parse_terminal_environment(&args.environment, &args.unset_environment).unwrap();

        assert_eq!(
            environment.values().get("NO_COLOR"),
            Some(&Some("1".to_string()))
        );
        assert_eq!(environment.values().get("COLORTERM"), Some(&None));
        assert!(!environment.values().contains_key("FORCE_COLOR"));
    }

    #[test]
    fn parses_grouped_show_with_global_flags_after_subcommands() {
        let cli = Cli::try_parse_from([
            "hmux",
            "session",
            "show",
            "session-1",
            "--workspace",
            "workspace-1",
            "--json",
            "--discovery-root",
            "/tmp/hmux",
        ])
        .unwrap();
        assert!(cli.json);
        assert_eq!(cli.discovery_root, Some(PathBuf::from("/tmp/hmux")));
    }

    #[test]
    fn parses_bounded_probe_and_snapshot_without_attach() {
        let probe = Cli::try_parse_from([
            "hmux",
            "--json",
            "session",
            "probe",
            "session-1",
            "--workspace",
            "workspace-1",
        ])
        .unwrap();
        assert!(matches!(
            probe.command,
            Command::Session {
                command: SessionCommand::Probe { .. }
            }
        ));

        let batch = Cli::try_parse_from([
            "hmux",
            "--json",
            "session",
            "probe-batch",
            "--targets-json",
            r#"[{"sessionId":"session-1","workspaceId":"workspace-1"}]"#,
            "--probe-budget-ms",
            "250",
        ])
        .unwrap();
        let Command::Session {
            command: SessionCommand::ProbeBatch(batch),
        } = batch.command
        else {
            panic!("expected exact session batch probe")
        };
        assert_eq!(batch.probe_budget_ms, 250);

        let snapshot = Cli::try_parse_from([
            "hmux",
            "--json",
            "session",
            "snapshot",
            "session-1",
            "--workspace",
            "workspace-1",
        ])
        .unwrap();
        assert!(matches!(
            snapshot.command,
            Command::Session {
                command: SessionCommand::Snapshot { .. }
            }
        ));
    }

    #[test]
    fn parses_current_with_json_after_subcommand() {
        let cli = Cli::try_parse_from(["hmux", "current", "--json"]).unwrap();
        assert!(matches!(cli.command, Command::Current));
        assert!(cli.json);
    }

    #[test]
    fn parses_bounded_read_with_exact_workspace_identity() {
        let cli = Cli::try_parse_from([
            "hmux",
            "read",
            "managed-session-1",
            "--workspace",
            "workspace-1",
            "--lines",
            "7",
        ])
        .unwrap();
        let Command::Read(args) = cli.command else {
            panic!("expected read")
        };
        assert_eq!(args.session, "managed-session-1");
        assert_eq!(args.workspace.as_deref(), Some("workspace-1"));
        assert_eq!(args.lines, 7);
        assert_eq!(args.deadline_ms, 2500);
    }

    #[test]
    fn parses_live_upgrade_with_explicit_restart_confirmation() {
        let cli = Cli::try_parse_from([
            "hmux",
            "upgrade",
            "dev",
            "--confirm-restart",
            "--timeout-ms",
            "5000",
            "--json",
        ])
        .unwrap();
        let Command::Upgrade(args) = cli.command else {
            panic!("expected upgrade")
        };
        assert_eq!(args.session, "dev");
        assert!(args.confirm_restart);
        assert_eq!(args.timeout_ms, 5000);
        assert!(cli.json);
    }

    #[test]
    fn current_uses_the_exact_host_scoped_environment_identity() {
        let selector = current_session_selector_from(|name| match name {
            HMUX_ENV => Some("1".into()),
            HMUX_SESSION_ID_ENV => Some("standalone-1".into()),
            HMUX_WORKSPACE_ID_ENV => Some("workspace-1".into()),
            _ => None,
        })
        .unwrap();

        assert_eq!(
            selector,
            SessionSelector::new("standalone-1", Some("workspace-1".into()))
        );
    }

    #[test]
    fn current_explains_legacy_providers_without_identity_environment() {
        let error =
            current_session_selector_from(|name| (name == HMUX_ENV).then_some("1".to_string()))
                .unwrap_err();

        assert!(error.to_string().contains(HMUX_SESSION_ID_ENV));
    }

    /// 미탐침 세션의 실제 투영값. 두 열은 같은 probe에서 파생되므로 픽스처도
    /// 일관해야 한다 — 아니면 실제로는 못 나오는 조합을 검증하게 된다.
    fn unprobed_liveness() -> SessionLiveness {
        SessionLiveness {
            state: LivenessState::Unprobed,
            recoverability: Recoverability::Unknown,
        }
    }

    /// 목록은 manifest 상태(STATE)와 지금 사실(LIVE)을 나란히 보여준다.
    #[test]
    fn list_prints_a_reusable_short_id() {
        let output = render_sessions(
            &[SessionInspection::unprobed(descriptor())],
            &[unprobed_liveness()],
        );
        assert_eq!(
            output,
            concat!(
                "NAME\tID\tCLASS\tSTATE\tLIVE\tRECOVERY\tPID\n",
                "dev\t99684cad\tstandalone\tready\tunprobed\tunknown\t100\n",
            )
        );
    }

    #[cfg(unix)]
    #[test]
    fn send_keys_supports_navigation_and_function_keys() {
        assert_eq!(
            encode_send_keys(
                &["Up".into(), "Home".into(), "F5".into(), "Enter".into()],
                false
            )
            .unwrap(),
            b"\x1b[A\x1b[H\x1b[15~\r"
        );
    }

    #[test]
    fn recent_lines_are_plain_bounded_terminal_rows() {
        let lines = recent_visible_lines(b"\x1b[H\x1b[Jone\r\ntwo\r\nthree", 4, 20, 2);
        assert_eq!(lines, vec!["two", "three"]);
    }
}
