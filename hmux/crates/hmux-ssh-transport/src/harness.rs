//! A scripted exec channel, and the pump running on top of it.
//!
//! The contracts this crate has to hold — a write that is all-or-nothing, a
//! reader woken while blocked, two stalled directions that do not deadlock —
//! are all statements about what happens when the channel misbehaves in a
//! precise way. A real SSH server cannot be asked to accept exactly five bytes
//! of a frame and then die, so a test written against one would be asserting
//! something weaker than the invariant it claims to protect. The russh binding
//! is covered separately, end to end, in `tests/`.

use crate::channel::{ChannelEvent, ExecChannelReader, ExecChannelWriter};
use crate::pump;
use crate::shared::{SessionLifetime, SessionShared};
use crate::transport::{SshFrameReader, SshFrameWriter, SshInterrupt};
use hmux_session_protocol::{Detach, FrameBody, FrameCodec, FrameLimits, PROTOCOL_V1, WireFrame};
use std::collections::VecDeque;
use std::io;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

/// What the channel does with the next write.
#[derive(Clone, Copy, Debug)]
pub(crate) enum WriteStep {
    /// Take everything offered.
    TakeAll,
    /// Take at most this many bytes, so the pump has to come back for the
    /// rest — which is where a frame can be left half-committed.
    Take(usize),
    /// Fail. Whether this is a disconnect or a desynchronization depends
    /// entirely on how much of the current frame went out first.
    Fail,
    /// Never return. Models an SSH window that has closed.
    Stall,
}

pub(crate) struct ScriptedReader {
    events: UnboundedReceiver<ChannelEvent>,
}

impl ExecChannelReader for ScriptedReader {
    async fn next_event(&mut self) -> ChannelEvent {
        self.events.recv().await.unwrap_or(ChannelEvent::Ended)
    }
}

pub(crate) struct ScriptedWriter {
    steps: Arc<Mutex<VecDeque<WriteStep>>>,
    committed: Arc<Mutex<Vec<u8>>>,
}

impl ExecChannelWriter for ScriptedWriter {
    async fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let step = self
            .steps
            .lock()
            .expect("script lock")
            .pop_front()
            .unwrap_or(WriteStep::TakeAll);
        let taken = match step {
            WriteStep::TakeAll => bytes.len(),
            WriteStep::Take(limit) => limit.min(bytes.len()),
            WriteStep::Fail => {
                return Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "scripted failure",
                ));
            }
            WriteStep::Stall => std::future::pending().await,
        };
        self.committed
            .lock()
            .expect("committed lock")
            .extend_from_slice(&bytes[..taken]);
        Ok(taken)
    }

    async fn finish(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// A transport wired to a scripted channel, plus the controls a test needs.
///
/// The reader is behind an `Arc<Mutex<_>>` for one reason: the tests that
/// matter most here are about a reader that is *already blocked*, so the read
/// has to happen on a thread this one can outlive. A borrow cannot cross that
/// boundary, and a scoped thread would join — and therefore hang — exactly
/// when the property under test has failed.
pub(crate) struct Harness {
    reader: Arc<Mutex<SshFrameReader>>,
    pub(crate) writer: SshFrameWriter,
    pub(crate) interrupt: Arc<SshInterrupt>,
    /// Feeds the channel's read half.
    pub(crate) events: UnboundedSender<ChannelEvent>,
    /// Exactly what the channel accepted, in order.
    pub(crate) committed: Arc<Mutex<Vec<u8>>>,
}

impl Harness {
    pub(crate) fn new(steps: Vec<WriteStep>) -> Self {
        Self::with_admission_timeout(steps, None)
    }

    pub(crate) fn with_admission_timeout(
        steps: Vec<WriteStep>,
        admission_timeout: Option<Duration>,
    ) -> Self {
        let shared = Arc::new(SessionShared::new(admission_timeout));
        let (events, receiver) = unbounded_channel();
        let committed = Arc::new(Mutex::new(Vec::new()));

        let pump_shared = Arc::clone(&shared);
        let writer = ScriptedWriter {
            steps: Arc::new(Mutex::new(steps.into_iter().collect())),
            committed: Arc::clone(&committed),
        };
        let handle = thread::Builder::new()
            .name("hmux-ssh-harness".to_string())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("harness runtime");
                runtime.block_on(pump::run(
                    ScriptedReader { events: receiver },
                    writer,
                    &pump_shared,
                ));
            })
            .expect("harness pump thread");

        let session = SessionLifetime::new(shared, handle);
        Self {
            reader: Arc::new(Mutex::new(SshFrameReader::new(Arc::clone(&session)))),
            writer: SshFrameWriter::new(Arc::clone(&session)),
            interrupt: Arc::new(SshInterrupt::new(session)),
            events,
            committed,
        }
    }

    pub(crate) fn send(&self, bytes: &[u8]) {
        self.events
            .send(ChannelEvent::Data(bytes.to_vec()))
            .expect("scripted channel accepts data");
    }

    /// Runs `body` against the reader on another thread, failing rather than
    /// hanging if it never returns.
    pub(crate) fn with_reader_within<T: Send + 'static>(
        &self,
        budget: Duration,
        body: impl FnOnce(&mut SshFrameReader) -> T + Send + 'static,
    ) -> T {
        let reader = Arc::clone(&self.reader);
        within(budget, move || {
            body(&mut reader.lock().expect("reader lock"))
        })
    }

    /// For reads that cannot block: everything they need is already buffered.
    pub(crate) fn with_reader<T>(&self, body: impl FnOnce(&mut SshFrameReader) -> T) -> T {
        body(&mut self.reader.lock().expect("reader lock"))
    }
}

pub(crate) fn codec() -> FrameCodec {
    FrameCodec::new(FrameLimits::default())
}

pub(crate) fn frame(reason: &str) -> WireFrame {
    WireFrame {
        protocol_version: PROTOCOL_V1,
        frame_id: 1,
        body: FrameBody::Detach(Detach {
            reason: Some(reason.to_string()),
        }),
    }
}

pub(crate) fn encoded(codec: &FrameCodec, reason: &str) -> Vec<u8> {
    codec.encode(&frame(reason)).expect("frame encodes")
}

pub(crate) fn reason_of(outcome: hmux_session_protocol::transport::FrameOutcome) -> String {
    let Some(decoded) = outcome else {
        panic!("expected a frame, got a clean close");
    };
    match &decoded.frame().body {
        FrameBody::Detach(detach) => detach.reason.clone().unwrap_or_default(),
        other => panic!("unexpected body {other:?}"),
    }
}

/// Runs `body` on its own thread and fails rather than hanging.
///
/// Every wake-path test here has the same failure mode when the wake does not
/// arrive: the thread blocks forever. A hung suite reports nothing, so the
/// deadline turns "the reader was never woken" into an assertion.
pub(crate) fn within<T: Send + 'static>(
    budget: Duration,
    body: impl FnOnce() -> T + Send + 'static,
) -> T {
    let (done, wait) = std::sync::mpsc::sync_channel(1);
    let worker = thread::spawn(move || {
        let value = body();
        let _ = done.send(value);
    });
    match wait.recv_timeout(budget) {
        Ok(value) => {
            worker.join().expect("worker thread");
            value
        }
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => match worker.join() {
            Err(panic) => std::panic::resume_unwind(panic),
            Ok(()) => panic!("the worker finished without producing a value"),
        },
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
            panic!("blocked for more than {budget:?} -- nothing woke it")
        }
    }
}
