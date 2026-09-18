//! The dialer: an SSH exec channel in, an `AttachedTransport` out.
//!
//! One SSH connection per target, many exec channels on it. Every attach,
//! catalog listing and lifecycle request used to open its own TCP connection
//! and run its own key exchange and authentication; a workspace with a few
//! remote panes paid that a dozen times over on startup, and paid it again for
//! every poller tick. A connection is now kept per (endpoint, user, pinned
//! keys) for as long as something is using it, plus a short idle grace, and
//! each request opens a channel on it — which is what the SSH protocol
//! multiplexes for.

use crate::error::SshTransportError;
use crate::pump;
use crate::session::{
    AuthenticatedSession, OpenExecError, SshExecConfig, connect_authenticated, open_exec,
};
use crate::shared::{PumpOwner, SessionLifetime, SessionShared};
use crate::transport::{SshFrameReader, SshFrameWriter, SshInterrupt};
use hmux_client::transport::AttachedTransport;
use std::collections::HashMap;
use std::io;
use std::rc::Rc;
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender, sync_channel};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

/// How long a connection with no channels on it stays open for the next
/// request. Long enough to span the pollers that ask a box something every
/// few seconds; short enough that a box a person stopped using is let go.
const CONNECTION_IDLE_GRACE: Duration = Duration::from_secs(120);

/// The three halves of a live exec channel, before they are erased behind
/// `AttachedTransport`'s trait objects.
///
/// Exposed because `AttachedTransport`'s halves are deliberately unreachable
/// from outside `hmux-client` — that privacy is what stops a caller pairing a
/// colocation claim with a carrier it chose, so it is not something to widen
/// for convenience. Anything that needs raw frame access (this crate's own
/// end-to-end tests, a diagnostic that speaks to something which is not a Host)
/// takes the halves here instead, where no attestation is involved at all.
pub struct SshTransportHalves {
    pub reader: SshFrameReader,
    pub writer: SshFrameWriter,
    pub interrupt: Arc<SshInterrupt>,
}

/// Connects to a gateway over SSH and speaks Hmux frames to it.
pub struct SshExecDialer;

impl SshExecDialer {
    /// Opens a channel to the gateway (on a shared connection, connecting when
    /// there is none) and hands back a transport the client can attach over.
    ///
    /// The attestation is [`AttachedTransport::relayed`], and no colocation
    /// witness is reachable from here. Everything a Unix socket silently proves
    /// is absent: the address did not come from a manifest this process read
    /// under `path_security`, no kernel credential call happened, and the peer's
    /// pids belong to another kernel. That is enforced by construction rather
    /// than by this comment — `relayed` is the only constructor this crate can
    /// name, so attaching a witness is not something a mistake here could do.
    pub fn open(config: SshExecConfig) -> Result<AttachedTransport, SshTransportError> {
        let halves = Self::open_halves(config)?;
        Ok(AttachedTransport::relayed(
            Box::new(halves.reader),
            Box::new(halves.writer),
            halves.interrupt,
        ))
    }

    /// The same connect, without erasing the halves behind trait objects.
    ///
    /// The blocking traits and an async SSH library meet on a thread: one per
    /// connection, which owns the runtime, the session and every channel on
    /// it. Each channel's pump is a task there, and the halves handed back
    /// hold that task's lifetime rather than the thread's, so dropping them
    /// ends the channel and leaves the connection for whoever else is on it.
    pub fn open_halves(config: SshExecConfig) -> Result<SshTransportHalves, SshTransportError> {
        let deadline = Instant::now()
            .checked_add(config.connect_timeout)
            .ok_or_else(|| {
                SshTransportError::Runtime(io::Error::other("the SSH connect timeout overflowed"))
            })?;
        Self::open_halves_before(config, deadline)
    }

    /// Bounds pool admission, authentication and channel opening by the same
    /// caller deadline. A shorter connect timeout still applies to this open.
    pub fn open_halves_before(
        config: SshExecConfig,
        deadline: Instant,
    ) -> Result<SshTransportHalves, SshTransportError> {
        let now = Instant::now();
        let budget = config
            .connect_timeout
            .min(deadline.saturating_duration_since(now));
        let deadline = OpenDeadline {
            at: now + budget,
            budget,
        };
        deadline.remaining("opening the SSH transport")?;
        let shared = Arc::new(SessionShared::new(config.write_admission_timeout));
        let slot = registry().slot(&ConnectionKey::of(&config));

        // A connection found in the slot may have died since it was last
        // used; a channel that cannot be opened on it is answered by a fresh
        // connection, once. A fresh connection's failure is the answer.
        let mut fresh = false;
        for _ in 0..2 {
            let connection = match slot.connection(&config, deadline)? {
                Connected::Existing(connection) => connection,
                Connected::Fresh(connection) => {
                    fresh = true;
                    connection
                }
            };
            match connection.open_channel(config.clone(), Arc::clone(&shared), deadline) {
                Ok(finished) => {
                    let session = SessionLifetime::owned_by(shared, PumpOwner::Task(finished));
                    return Ok(SshTransportHalves {
                        reader: SshFrameReader::new(Arc::clone(&session)),
                        writer: SshFrameWriter::new(Arc::clone(&session)),
                        interrupt: Arc::new(SshInterrupt::new(Arc::clone(&session))),
                    });
                }
                Err(OpenFailure::Refused(error)) => return Err(error),
                Err(OpenFailure::ConnectionGone(error)) => {
                    slot.forget(&connection);
                    if fresh {
                        return Err(error);
                    }
                }
            }
        }
        Err(SshTransportError::Runtime(io::Error::other(
            "the shared SSH connection went away twice while opening a channel",
        )))
    }
}

#[derive(Clone, Copy)]
struct OpenDeadline {
    at: Instant,
    budget: Duration,
}

impl OpenDeadline {
    fn expired(self, phase: &'static str) -> SshTransportError {
        SshTransportError::Timeout {
            phase,
            after: self.budget,
        }
    }

    fn remaining(self, phase: &'static str) -> Result<Duration, SshTransportError> {
        self.at
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(|| self.expired(phase))
    }
}

/// Everything that decides whether two configs may share a connection.
///
/// The credential is deliberately not part of it: a connection already
/// authenticated as this user on this box serves any caller who would have
/// authenticated as the same user, and keeping key material in a map key
/// would hold it for the life of the process. The command, timeouts and
/// admission policy are per channel.
#[derive(Clone, Eq, Hash, PartialEq)]
struct ConnectionKey {
    endpoint: crate::session::SshEndpoint,
    user: String,
    host_key: crate::session::HostKeyPolicy,
}

impl ConnectionKey {
    fn of(config: &SshExecConfig) -> Self {
        Self {
            endpoint: config.endpoint.clone(),
            user: config.user.clone(),
            host_key: config.host_key.clone(),
        }
    }
}

/// One handshake per target. Waiters share its result while keeping their own
/// deadlines; no slot lock is held across network I/O.
#[derive(Default)]
struct ConnectionSlot {
    state: Mutex<SlotState>,
    changed: Condvar,
}

#[derive(Default)]
struct SlotState {
    connection: Option<Arc<SharedConnection>>,
    connecting: bool,
    /// Counts handshakes attempted here, so a caller that queued behind one
    /// can tell that the failure it finds is the one it waited for.
    attempts: u64,
    last_failure: Option<(u64, String)>,
}

enum Connected {
    Existing(Arc<SharedConnection>),
    Fresh(Arc<SharedConnection>),
}

impl ConnectionSlot {
    fn connection(
        &self,
        config: &SshExecConfig,
        deadline: OpenDeadline,
    ) -> Result<Connected, SshTransportError> {
        let mut state = self.lock();
        let waited_for = state.connecting.then_some(state.attempts);
        while state.connecting {
            let remaining = deadline.remaining("waiting for the shared SSH connection")?;
            state = self
                .changed
                .wait_timeout(state, remaining)
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .0;
        }
        deadline.remaining("opening the SSH connection")?;
        if let Some(connection) = state
            .connection
            .as_ref()
            .filter(|connection| connection.is_live())
        {
            return Ok(Connected::Existing(Arc::clone(connection)));
        }
        if let Some((attempt, detail)) = &state.last_failure {
            if waited_for.is_some_and(|waiting| *attempt >= waiting) {
                // The handshake this caller queued behind just failed; the
                // box is not going to answer differently a moment later.
                return Err(SshTransportError::Connect {
                    target: format!("{}:{}", config.endpoint.host, config.endpoint.port),
                    detail: detail.clone(),
                });
            }
        }
        state.attempts += 1;
        let attempt = state.attempts;
        state.connecting = true;
        drop(state);
        let result = SharedConnection::connect(config, deadline);
        let mut state = self.lock();
        state.connecting = false;
        self.changed.notify_all();
        match result {
            Ok(connection) => {
                let connection = Arc::new(connection);
                state.connection = Some(Arc::clone(&connection));
                state.last_failure = None;
                Ok(Connected::Fresh(connection))
            }
            Err(error) => {
                state.last_failure = Some((attempt, error.to_string()));
                Err(error)
            }
        }
    }

    fn forget(&self, connection: &Arc<SharedConnection>) {
        let mut state = self.lock();
        if state
            .connection
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, connection))
        {
            state.connection = None;
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, SlotState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[derive(Default)]
struct ConnectionRegistry {
    slots: Mutex<HashMap<ConnectionKey, Arc<ConnectionSlot>>>,
}

impl ConnectionRegistry {
    fn slot(&self, key: &ConnectionKey) -> Arc<ConnectionSlot> {
        let mut slots = self
            .slots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Arc::clone(slots.entry(key.clone()).or_default())
    }
}

fn registry() -> &'static ConnectionRegistry {
    static REGISTRY: OnceLock<ConnectionRegistry> = OnceLock::new();
    REGISTRY.get_or_init(ConnectionRegistry::default)
}

enum OpenFailure {
    /// The connection is up but this channel was refused (the gateway is not
    /// installed, the exec request failed). Retrying elsewhere changes nothing.
    Refused(SshTransportError),
    /// The connection itself is gone or unresponsive; a fresh one may succeed.
    ConnectionGone(SshTransportError),
}

struct ChannelRequest {
    config: SshExecConfig,
    shared: Arc<SessionShared>,
    report: SyncSender<Result<Receiver<()>, OpenFailure>>,
    deadline: OpenDeadline,
}

/// One authenticated SSH connection and the thread that drives it.
struct SharedConnection {
    requests: UnboundedSender<ChannelRequest>,
}

impl SharedConnection {
    /// Connects and authenticates on a new thread, returning once that is
    /// known to have succeeded. The thread then serves channel requests until
    /// the connection dies or sits idle past the grace period.
    fn connect(config: &SshExecConfig, deadline: OpenDeadline) -> Result<Self, SshTransportError> {
        let remaining = deadline.remaining("the SSH handshake")?;
        let (requests, inbox) = unbounded_channel();
        let (report, outcome) = sync_channel(1);
        let config = config.clone();
        thread::Builder::new()
            .name("hmux-ssh-transport".to_string())
            .spawn(move || run_connection(config, inbox, &report, deadline))
            .map_err(SshTransportError::Runtime)?;
        match outcome.recv_timeout(remaining) {
            Ok(Ok(())) => Ok(Self { requests }),
            Ok(Err(error)) => Err(error),
            Err(RecvTimeoutError::Timeout) => Err(deadline.expired("the SSH handshake")),
            Err(RecvTimeoutError::Disconnected) => Err(SshTransportError::Runtime(
                io::Error::other("the Hmux SSH transport thread stopped before reporting"),
            )),
        }
    }

    /// Whether the driving thread is still taking requests. A thread that
    /// left (idle, or the connection died) dropped its inbox.
    fn is_live(&self) -> bool {
        !self.requests.is_closed()
    }

    fn open_channel(
        &self,
        config: SshExecConfig,
        shared: Arc<SessionShared>,
        deadline: OpenDeadline,
    ) -> Result<Receiver<()>, OpenFailure> {
        let remaining = deadline
            .remaining("opening the SSH exec channel")
            .map_err(OpenFailure::Refused)?;
        let (report, outcome) = sync_channel(1);
        let gone = |detail: &str| {
            OpenFailure::ConnectionGone(SshTransportError::Runtime(io::Error::other(
                detail.to_string(),
            )))
        };
        self.requests
            .send(ChannelRequest {
                config,
                shared,
                report,
                deadline,
            })
            .map_err(|_| gone("the shared SSH connection has already closed"))?;
        outcome
            .recv_timeout(remaining)
            .map_err(|error| match error {
                RecvTimeoutError::Timeout => {
                    OpenFailure::Refused(deadline.expired("opening the SSH exec channel"))
                }
                RecvTimeoutError::Disconnected => {
                    gone("the shared SSH connection closed before opening the channel")
                }
            })?
    }
}

fn run_connection(
    config: SshExecConfig,
    inbox: UnboundedReceiver<ChannelRequest>,
    report: &SyncSender<Result<(), SshTransportError>>,
    deadline: OpenDeadline,
) {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            let _ = report.send(Err(SshTransportError::Runtime(error)));
            return;
        }
    };
    let local = tokio::task::LocalSet::new();
    local.block_on(&runtime, async move {
        let session =
            match tokio::time::timeout_at(deadline.at.into(), connect_authenticated(&config)).await
            {
                Err(_) => {
                    let _ = report.send(Err(deadline.expired("the SSH handshake")));
                    return;
                }
                Ok(Err(error)) => {
                    let _ = report.send(Err(error));
                    return;
                }
                Ok(Ok(session)) => session,
            };
        if report.send(Ok(())).is_err() {
            return;
        }
        serve_channels(session, inbox).await;
        // Returning drops the session handle, and with it the connection.
    });
}

/// What a channel task tells the connection loop.
enum ChannelEvent {
    /// The channel (or its attempt to open) is over.
    Ended(u64),
    /// The task found the connection closed or unresponsive; stop taking
    /// requests for it.
    ConnectionGone,
}

/// Serves channel requests on one session until it is idle past the grace
/// period or the connection is gone. Each request is its own task, so one
/// slow channel open never holds the others; live channels on a dead
/// connection are woken so their pumps end and their readers are released.
async fn serve_channels(
    session: AuthenticatedSession,
    mut inbox: UnboundedReceiver<ChannelRequest>,
) {
    // Channel tasks share the handle on this thread's LocalSet; russh opens
    // channels through `&self`.
    let session = Rc::new(session);
    let (events, mut event_inbox) = unbounded_channel::<ChannelEvent>();
    let mut live: HashMap<u64, Arc<SessionShared>> = HashMap::new();
    let mut next_channel = 0u64;
    let mut accepting = true;
    loop {
        tokio::select! {
            request = inbox.recv(), if accepting => {
                let Some(request) = request else { break };
                if session.is_closed() {
                    let _ = request.report.send(Err(OpenFailure::ConnectionGone(
                        SshTransportError::Runtime(io::Error::other(
                            "the shared SSH connection is closed",
                        )),
                    )));
                    accepting = false;
                } else {
                    let id = next_channel;
                    next_channel += 1;
                    live.insert(id, Arc::clone(&request.shared));
                    tokio::task::spawn_local(serve_channel(
                        id,
                        Rc::clone(&session),
                        request,
                        events.clone(),
                    ));
                }
            }
            Some(event) = event_inbox.recv() => match event {
                ChannelEvent::Ended(id) => {
                    live.remove(&id);
                }
                ChannelEvent::ConnectionGone => accepting = false,
            },
            () = tokio::time::sleep(CONNECTION_IDLE_GRACE), if accepting && live.is_empty() => {
                break;
            }
        }
        if accepting && session.is_closed() {
            accepting = false;
        }
        if !accepting {
            // Nothing new will be admitted: release anyone still queued, wake
            // the channels the box left behind, and leave once the last one
            // has ended. A closed inbox is how the slot learns this
            // connection is done.
            inbox.close();
            while let Ok(request) = inbox.try_recv() {
                let _ = request.report.send(Err(OpenFailure::ConnectionGone(
                    SshTransportError::Runtime(io::Error::other(
                        "the shared SSH connection is closed",
                    )),
                )));
            }
            for shared in live.values() {
                shared.interrupt();
            }
            if live.is_empty() {
                break;
            }
        }
    }
}

/// Opens one exec channel, reports to the caller, and pumps it to its end.
async fn serve_channel(
    id: u64,
    session: Rc<AuthenticatedSession>,
    request: ChannelRequest,
    events: UnboundedSender<ChannelEvent>,
) {
    let opened = tokio::time::timeout_at(
        request.deadline.at.into(),
        open_exec(&session, &request.config),
    )
    .await;
    let channel = match opened {
        Ok(Ok(channel)) => channel,
        Ok(Err(OpenExecError::Exec(error))) if !session.is_closed() => {
            let _ = request.report.send(Err(OpenFailure::Refused(error)));
            let _ = events.send(ChannelEvent::Ended(id));
            return;
        }
        Ok(Err(OpenExecError::Exec(error) | OpenExecError::ChannelOpen(error))) => {
            let _ = request.report.send(Err(OpenFailure::ConnectionGone(error)));
            let _ = events.send(ChannelEvent::ConnectionGone);
            let _ = events.send(ChannelEvent::Ended(id));
            return;
        }
        Err(_) => {
            // A caller's remaining budget can be shorter than a healthy
            // channel open. Expiry cancels only this request, not other panes
            // already using the authenticated connection.
            let _ = request.report.send(Err(OpenFailure::Refused(
                request.deadline.expired("opening the SSH exec channel"),
            )));
            let _ = events.send(ChannelEvent::Ended(id));
            return;
        }
    };
    let mut alive = true;
    for event in channel.prelude {
        alive &= pump::apply_event(event, &request.shared);
    }
    let (finished, finished_observer) = sync_channel::<()>(0);
    if request.report.send(Ok(finished_observer)).is_ok() {
        if alive {
            pump::run(channel.reader, channel.writer, &request.shared).await;
        } else {
            request.shared.inbound.mark_ended();
            request
                .shared
                .outbound
                .mark_closed("the SSH channel is gone");
            let mut writer = channel.writer;
            crate::channel::ExecChannelWriter::close(&mut writer).await;
        }
    } else {
        // The caller gave up while the channel was opening; close it rather
        // than leave the gateway running for nobody.
        let mut writer = channel.writer;
        crate::channel::ExecChannelWriter::close(&mut writer).await;
    }
    drop(finished);
    let _ = events.send(ChannelEvent::Ended(id));
}
