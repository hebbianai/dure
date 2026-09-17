//! File-descriptor transports: Unix sockets today, pipes for a relay.
//!
//! The hard part is not reading. It is **waking a reader that is already
//! blocked**, from another thread, so a detach does not hang.
//!
//! A socket gets this free. `shutdown(Shutdown::Both)` is a socket-object
//! operation: the kernel wakes everyone blocked on any duplicate of that
//! descriptor, with no shared state between the threads. Production depends on
//! it — the adapter hands a connection to a dedicated reader thread and later
//! `join()`s it, so a wake that never arrives turns app shutdown into a hang.
//!
//! A pipe has no equivalent. Closing your own duplicate does not wake a peer
//! blocked on the other one. So a pipe-backed transport has to carry its own
//! wake path: a second descriptor in the `poll` set that another thread can
//! make readable. That is [`SelfPipe`], and it is the single largest cost of a
//! relay not being able to use a socket — which is in turn why a socketpair
//! carrier was rejected despite making all of this free.
//!
//! Sockets deliberately do **not** allocate one. Two descriptors and an extra
//! pollfd on every read of every local attach, to duplicate what `shutdown`
//! already does, is a cost with no benefit.

#[cfg(test)]
use super::FrameOutcome;
use super::{
    FrameProgress, FrameReader, FrameWriter, PayloadOutcome, TransportError, TransportInterrupt,
};
use hmux_session_protocol::FrameCodec;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::net::UnixStream;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

const WRITE_OPERATION: &str = "write Hmux frame";

fn poll_timeout_ms(remaining: Duration) -> libc::c_int {
    let whole_ms = remaining.as_millis();
    let rounded_ms = whole_ms.saturating_add(u128::from(remaining.subsec_nanos() % 1_000_000 != 0));
    rounded_ms.max(1).min(libc::c_int::MAX as u128) as libc::c_int
}

/// Waits until a Unix descriptor can accept bytes before an absolute deadline.
///
/// Both local dialers and Host-side connection writers use this one readiness
/// rule so a write timeout has identical retry and poisoning semantics on
/// either end of the socket.
pub fn wait_until_writable(fd: RawFd, deadline: Instant) -> io::Result<bool> {
    loop {
        let now = Instant::now();
        if now >= deadline {
            return Ok(false);
        }
        let mut descriptor = libc::pollfd {
            fd,
            events: libc::POLLOUT,
            revents: 0,
        };
        // SAFETY: descriptor points to one initialized pollfd for the duration
        // of the call, and this function never closes or transfers `fd`.
        let result = unsafe {
            libc::poll(
                &mut descriptor,
                1,
                poll_timeout_ms(deadline.saturating_duration_since(now)),
            )
        };
        if result > 0 {
            return Ok(true);
        }
        if result == 0 {
            continue;
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

/// A descriptor pair used only to make a blocked `poll` return.
pub struct SelfPipe {
    read: RawFd,
    write: RawFd,
    signalled: AtomicBool,
}

impl SelfPipe {
    pub fn new() -> io::Result<Arc<Self>> {
        let fds = Self::create()?;
        Ok(Arc::new(Self {
            read: fds[0],
            write: fds[1],
            signalled: AtomicBool::new(false),
        }))
    }

    /// `pipe2` does not exist on Apple platforms — it is declared for Linux,
    /// the BSDs, Solaris and others, but there is nothing for it anywhere under
    /// libc's `unix/bsd/apple`. macOS is the primary development, CI and ship
    /// target, so an unconditional `pipe2` would fail to compile before it
    /// could fail to run.
    ///
    /// The fallback is `pipe` plus `FD_CLOEXEC` on both ends. That is not
    /// atomic — a `fork` racing between the two calls would inherit the
    /// descriptors — which is acceptable here only because hmux-client never
    /// forks. Anything that changes should use `pipe2` where it exists.
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    fn create() -> io::Result<[RawFd; 2]> {
        let mut fds = [0_i32; 2];
        // SAFETY: fds points to two writable ints, which is what pipe expects.
        if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        for fd in fds {
            // SAFETY: fd was just returned by a successful pipe call.
            if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } == -1 {
                let error = io::Error::last_os_error();
                // SAFETY: both descriptors are live and owned by us.
                unsafe {
                    libc::close(fds[0]);
                    libc::close(fds[1]);
                }
                return Err(error);
            }
        }
        Ok(fds)
    }

    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    fn create() -> io::Result<[RawFd; 2]> {
        let mut fds = [0_i32; 2];
        // SAFETY: fds points to two writable ints, which is what pipe2 expects.
        if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(fds)
    }

    fn read_fd(&self) -> RawFd {
        self.read
    }

    fn was_signalled(&self) -> bool {
        self.signalled.load(Ordering::Acquire)
    }
}

impl TransportInterrupt for SelfPipe {
    fn interrupt(&self) {
        // Set the flag before the write, so a reader that wakes on the byte
        // always observes the reason. A repeated interrupt is harmless: the
        // pipe buffer only has to become readable, not stay empty.
        self.signalled.store(true, Ordering::Release);
        let byte = 1_u8;
        // SAFETY: write is a live descriptor we own, and byte is one readable
        // byte. A full pipe means an earlier wake is still pending, which is
        // just as good, so the result is deliberately ignored.
        unsafe {
            libc::write(self.write, std::ptr::from_ref(&byte).cast(), 1);
        }
    }
}

impl Drop for SelfPipe {
    fn drop(&mut self) {
        // SAFETY: both descriptors are owned by this value and closed once.
        unsafe {
            libc::close(self.read);
            libc::close(self.write);
        }
    }
}

/// Cancels a socket-backed reader the way the kernel already supports.
pub struct SocketInterrupt {
    socket: UnixStream,
}

impl SocketInterrupt {
    #[must_use]
    pub fn new(socket: UnixStream) -> Self {
        Self { socket }
    }
}

impl TransportInterrupt for SocketInterrupt {
    fn interrupt(&self) {
        // Wakes every thread blocked on any duplicate of this socket. The
        // reader cannot distinguish this from a remote hangup, which is a
        // known limitation rather than an oversight: on this transport a
        // deliberate detach and a peer disappearing look identical, and both
        // mean "stop reading".
        let _ = self.socket.shutdown(std::net::Shutdown::Both);
    }
}

/// A Unix socket writer with one absolute deadline for the complete frame.
///
/// A timeout before the first byte is retry-safe. Once any prefix reaches the
/// peer, the writer is permanently poisoned because no later write can restore
/// frame alignment.
pub struct UnixSocketFrameWriter {
    stream: UnixStream,
    poisoned: bool,
}

impl UnixSocketFrameWriter {
    #[must_use]
    pub fn new(stream: UnixStream) -> Self {
        Self {
            stream,
            poisoned: false,
        }
    }

    fn write_timeout(&mut self, written: usize) -> TransportError {
        if written > 0 {
            self.poisoned = true;
            TransportError::CompletionTimeout
        } else {
            TransportError::WriteNotStarted
        }
    }
}

impl FrameWriter for UnixSocketFrameWriter {
    fn write_frame(&mut self, encoded: &[u8]) -> Result<(), TransportError> {
        if self.poisoned {
            return Err(TransportError::CompletionTimeout);
        }
        match self
            .stream
            .write_all(encoded)
            .and_then(|()| self.stream.flush())
        {
            Ok(()) => Ok(()),
            Err(source) => {
                self.poisoned = true;
                Err(TransportError::Io {
                    operation: WRITE_OPERATION,
                    source,
                })
            }
        }
    }

    fn write_frame_before(
        &mut self,
        encoded: &[u8],
        deadline: Option<Instant>,
    ) -> Result<(), TransportError> {
        let Some(deadline) = deadline else {
            return self.write_frame(encoded);
        };
        if self.poisoned {
            return Err(TransportError::CompletionTimeout);
        }
        if Instant::now() >= deadline {
            return Err(self.write_timeout(0));
        }
        self.stream
            .set_nonblocking(true)
            .map_err(|source| TransportError::Io {
                operation: WRITE_OPERATION,
                source,
            })?;
        let mut written = 0;
        let result = loop {
            if Instant::now() >= deadline {
                break Err(self.write_timeout(written));
            }
            match self.stream.write(&encoded[written..]) {
                Ok(0) => {
                    self.poisoned = true;
                    break Err(TransportError::Io {
                        operation: WRITE_OPERATION,
                        source: io::Error::new(
                            io::ErrorKind::WriteZero,
                            "failed to write the whole Hmux frame",
                        ),
                    });
                }
                Ok(count) => {
                    written += count;
                    if written == encoded.len() {
                        break Ok(());
                    }
                }
                Err(source) if source.kind() == io::ErrorKind::Interrupted => {}
                Err(source) if source.kind() == io::ErrorKind::WouldBlock => {
                    match wait_until_writable(self.stream.as_raw_fd(), deadline) {
                        Ok(true) => {}
                        Ok(false) => break Err(self.write_timeout(written)),
                        Err(source) => {
                            self.poisoned = true;
                            break Err(TransportError::Io {
                                operation: WRITE_OPERATION,
                                source,
                            });
                        }
                    }
                }
                Err(source) => {
                    self.poisoned = true;
                    break Err(TransportError::Io {
                        operation: WRITE_OPERATION,
                        source,
                    });
                }
            }
        };
        if let Err(source) = self.stream.set_nonblocking(false) {
            self.poisoned = true;
            return Err(TransportError::Io {
                operation: WRITE_OPERATION,
                source,
            });
        }
        result
    }

    fn close_write(&mut self) -> Result<(), TransportError> {
        self.stream.flush().map_err(|source| TransportError::Io {
            operation: "flush Hmux transport",
            source,
        })
    }
}

enum Readiness {
    Data,
    Interrupted,
    TimedOut,
}

/// Reads frames from a descriptor, with readiness driven by `poll` so the same
/// code works for a socket and for a pipe.
pub struct FdFrameReader<S: AsRawFd + Read> {
    source: S,
    wake: Option<Arc<SelfPipe>>,
    /// Bounds time-to-first-byte. Retry-safe.
    first_byte_timeout: Option<Duration>,
    /// Bounds a whole frame once it has started. Firing this desynchronizes
    /// the stream, so it stays `None` until the caller can also poison the
    /// connection — see the migration note on steps 5 and 6.
    completion_timeout: Option<Duration>,
    frame_started: Option<Instant>,
    interrupted: bool,
}

impl<S: AsRawFd + Read> FdFrameReader<S> {
    #[must_use]
    pub fn new(source: S) -> Self {
        Self {
            source,
            wake: None,
            first_byte_timeout: None,
            completion_timeout: None,
            frame_started: None,
            interrupted: false,
        }
    }

    /// Adds an explicit wake path. Only pipe-backed transports need this;
    /// sockets are cancelled through [`SocketInterrupt`] instead.
    #[must_use]
    pub fn with_wake(mut self, wake: Arc<SelfPipe>) -> Self {
        self.wake = Some(wake);
        self
    }

    pub fn set_first_byte_timeout(&mut self, timeout: Option<Duration>) {
        self.first_byte_timeout = timeout;
    }

    pub fn set_completion_timeout(&mut self, timeout: Option<Duration>) {
        self.completion_timeout = timeout;
    }

    fn poll_ready(&mut self, timeout: Option<Duration>) -> io::Result<Readiness> {
        if let Some(wake) = &self.wake {
            if wake.was_signalled() {
                return Ok(Readiness::Interrupted);
            }
        }
        let deadline = timeout.map(|budget| Instant::now() + budget);
        loop {
            let remaining = match deadline {
                Some(at) => {
                    let now = Instant::now();
                    if now >= at {
                        return Ok(Readiness::TimedOut);
                    }
                    let remaining = at - now;
                    let rounded_ms = remaining
                        .as_millis()
                        .saturating_add(u128::from(remaining.subsec_nanos() % 1_000_000 != 0));
                    rounded_ms.max(1).min(i32::MAX as u128) as i32
                }
                None => -1,
            };
            let mut fds = [
                libc::pollfd {
                    fd: self.source.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                },
                libc::pollfd {
                    fd: self.wake.as_ref().map_or(-1, |wake| wake.read_fd()),
                    events: libc::POLLIN,
                    revents: 0,
                },
            ];
            let count = if self.wake.is_some() { 2 } else { 1 };
            // SAFETY: fds points to `count` initialized pollfd values, and both
            // descriptors are borrowed from values that outlive this call.
            let ready = unsafe { libc::poll(fds.as_mut_ptr(), count, remaining) };
            if ready < 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::EINTR) {
                    continue;
                }
                return Err(error);
            }
            if ready == 0 {
                return Ok(Readiness::TimedOut);
            }
            // The wake path is checked first. If both are ready, a detach that
            // has already been requested must win: returning data would let a
            // reader start another frame the caller has no intention of
            // consuming, and the interrupt would only be seen one frame later.
            if count == 2 && fds[1].revents != 0 {
                return Ok(Readiness::Interrupted);
            }
            if fds[0].revents != 0 {
                return Ok(Readiness::Data);
            }
        }
    }

    fn budget(&self) -> Option<Duration> {
        match self.frame_started {
            // Mid-frame: the remaining completion budget, if one is armed.
            Some(started) => self.completion_timeout.map(|total| {
                let elapsed = started.elapsed();
                total.saturating_sub(elapsed)
            }),
            None => self.first_byte_timeout,
        }
    }
}

impl<S: AsRawFd + Read> Read for FdFrameReader<S> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        match self.poll_ready(self.budget())? {
            Readiness::Data => {
                let read = self.source.read(buffer)?;
                if read > 0 && self.frame_started.is_none() {
                    self.frame_started = Some(Instant::now());
                }
                Ok(read)
            }
            Readiness::Interrupted => {
                // Recorded rather than encoded in the error, because
                // `ErrorKind::Interrupted` is precisely the kind `read_exact`
                // retries on — returning it here would spin forever. One write
                // site, one read site, checked immediately in `read_frame`.
                self.interrupted = true;
                Err(io::Error::new(
                    io::ErrorKind::ConnectionAborted,
                    "Hmux transport read was interrupted",
                ))
            }
            Readiness::TimedOut => Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Hmux transport read deadline expired",
            )),
        }
    }
}

impl<S: AsRawFd + Read + Send> FrameReader for FdFrameReader<S> {
    fn wait_readable(&mut self, timeout: Option<Duration>) -> Result<(), TransportError> {
        match self
            .poll_ready(timeout)
            .map_err(|source| TransportError::Io {
                operation: "poll Hmux transport",
                source,
            })? {
            Readiness::Data => Ok(()),
            Readiness::Interrupted => Err(TransportError::Interrupted),
            Readiness::TimedOut => Err(TransportError::FirstByteTimeout),
        }
    }

    fn set_completion_timeout(&mut self, timeout: Option<Duration>) {
        self.completion_timeout = timeout;
    }

    fn try_read_complete_payload(
        &mut self,
        codec: &FrameCodec,
    ) -> Result<PayloadOutcome, TransportError> {
        if self.wake.as_ref().is_some_and(|wake| wake.was_signalled()) {
            return Err(TransportError::Interrupted);
        }

        let descriptor = self.source.as_raw_fd();
        let mut prefix = [0_u8; 4];
        // SAFETY: descriptor is borrowed from the live source and prefix is a
        // writable four-byte buffer. MSG_PEEK leaves the stream untouched.
        let peeked = unsafe {
            libc::recv(
                descriptor,
                prefix.as_mut_ptr().cast(),
                prefix.len(),
                libc::MSG_PEEK | libc::MSG_DONTWAIT,
            )
        };
        if peeked < 0 {
            let error = io::Error::last_os_error();
            if matches!(error.kind(), io::ErrorKind::WouldBlock)
                || matches!(error.raw_os_error(), Some(libc::ENOTSOCK))
            {
                return Ok(None);
            }
            return Err(TransportError::Io {
                operation: "inspect buffered Hmux frame",
                source: error,
            });
        }
        if usize::try_from(peeked).unwrap_or(0) < prefix.len() {
            return Ok(None);
        }

        let declared = usize::try_from(u32::from_be_bytes(prefix))
            .expect("u32 always fits usize on supported hosts");
        if declared == 0 || declared > codec.limits().max_frame_bytes {
            return Ok(None);
        }
        let mut buffered = 0_i32;
        // SAFETY: descriptor is live and buffered points to one writable int,
        // which is the platform contract for FIONREAD.
        if unsafe { libc::ioctl(descriptor, libc::FIONREAD, &mut buffered) } < 0 {
            let error = io::Error::last_os_error();
            if matches!(error.raw_os_error(), Some(code) if code == libc::ENOTTY || code == libc::EINVAL)
            {
                return Ok(None);
            }
            return Err(TransportError::Io {
                operation: "measure buffered Hmux frame",
                source: error,
            });
        }
        let complete = usize::try_from(buffered)
            .ok()
            .is_some_and(|buffered| buffered >= prefix.len().saturating_add(declared));
        if !complete {
            return Ok(None);
        }
        self.read_payload(codec)
    }

    fn read_payload(&mut self, codec: &FrameCodec) -> Result<PayloadOutcome, TransportError> {
        self.interrupted = false;
        self.frame_started = None;
        let mut progress = FrameProgress::new();
        let result = super::drive_read_payload(self, &mut progress, codec);
        self.frame_started = None;
        if self.interrupted {
            // Deliberate cancellation, never stream damage — otherwise every
            // detach would mark a healthy connection desynchronized.
            return Err(TransportError::Interrupted);
        }
        result
    }
}

/// Writes frames to a descriptor.
pub struct FdFrameWriter<S: Write> {
    sink: S,
    poisoned: bool,
}

impl<S: Write> FdFrameWriter<S> {
    #[must_use]
    pub fn new(sink: S) -> Self {
        Self {
            sink,
            poisoned: false,
        }
    }

    #[must_use]
    pub fn is_poisoned(&self) -> bool {
        self.poisoned
    }
}

impl<S: Write + Send> FrameWriter for FdFrameWriter<S> {
    fn write_frame(&mut self, encoded: &[u8]) -> Result<(), TransportError> {
        if self.poisoned {
            return Err(TransportError::CompletionTimeout);
        }
        // `write_all` reports no partial-progress count, so a failure has to be
        // treated as "some prefix may be on the wire". That is the conservative
        // reading and the only safe one: a half-written length prefix makes the
        // peer interpret payload as a length.
        match self
            .sink
            .write_all(encoded)
            .and_then(|()| self.sink.flush())
        {
            Ok(()) => Ok(()),
            Err(source) => {
                self.poisoned = true;
                Err(TransportError::Io {
                    operation: "write Hmux frame",
                    source,
                })
            }
        }
    }

    fn close_write(&mut self) -> Result<(), TransportError> {
        self.sink.flush().map_err(|source| TransportError::Io {
            operation: "flush Hmux transport",
            source,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hmux_session_protocol::{Detach, FrameBody, FrameLimits, PROTOCOL_V1, WireFrame};
    use std::thread;

    fn codec() -> FrameCodec {
        FrameCodec::new(FrameLimits::default())
    }

    fn frame(reason: &str) -> WireFrame {
        WireFrame {
            protocol_version: PROTOCOL_V1,
            frame_id: 1,
            body: FrameBody::Detach(Detach {
                reason: Some(reason.to_string()),
            }),
        }
    }

    fn reason(outcome: FrameOutcome) -> String {
        let Some(decoded) = outcome else {
            panic!("expected a frame, got a clean close");
        };
        match &decoded.frame().body {
            FrameBody::Detach(detach) => detach.reason.clone().unwrap_or_default(),
            other => panic!("unexpected body {other:?}"),
        }
    }

    #[test]
    fn frames_round_trip_over_a_socket_pair() {
        let codec = codec();
        let (left, right) = UnixStream::pair().unwrap();
        let mut writer = FdFrameWriter::new(left);
        let mut reader = FdFrameReader::new(right);

        writer
            .write_frame(&codec.encode(&frame("hello")).unwrap())
            .unwrap();
        assert_eq!(reason(reader.read_frame(&codec).unwrap()), "hello");
    }

    #[test]
    fn buffered_payload_probe_consumes_nothing_until_the_whole_socket_frame_is_ready() {
        let codec = codec();
        let (mut left, right) = UnixStream::pair().unwrap();
        let mut reader = FdFrameReader::new(right);
        let first = codec.encode(&frame("split")).unwrap();
        let second = codec.encode(&frame("aligned-after-split")).unwrap();

        left.write_all(&first[..2]).unwrap();
        assert!(reader.try_read_complete_payload(&codec).unwrap().is_none());
        let middle = 4 + (first.len() - 4) / 2;
        left.write_all(&first[2..middle]).unwrap();
        assert!(reader.try_read_complete_payload(&codec).unwrap().is_none());
        left.write_all(&first[middle..]).unwrap();
        let payload = reader
            .try_read_complete_payload(&codec)
            .unwrap()
            .expect("the complete buffered payload is available");
        let decoded = codec
            .decode_payload_for_dispatch(&payload)
            .unwrap()
            .into_valid()
            .unwrap();
        assert!(matches!(
            decoded.body,
            FrameBody::Detach(Detach { reason: Some(reason) }) if reason == "split"
        ));

        left.write_all(&second).unwrap();
        assert_eq!(
            reason(reader.read_frame(&codec).unwrap()),
            "aligned-after-split"
        );
    }

    #[test]
    fn buffered_payload_probe_observes_an_interrupt_before_buffered_socket_data() {
        let codec = codec();
        let (mut left, right) = UnixStream::pair().unwrap();
        let wake = SelfPipe::new().unwrap();
        let mut reader = FdFrameReader::new(right).with_wake(Arc::clone(&wake));
        left.write_all(&codec.encode(&frame("must-not-win")).unwrap())
            .unwrap();
        wake.interrupt();

        assert!(matches!(
            reader.try_read_complete_payload(&codec).unwrap_err(),
            TransportError::Interrupted
        ));
    }

    #[test]
    fn a_first_byte_timeout_is_retry_safe_and_leaves_the_stream_usable() {
        let codec = codec();
        let (left, right) = UnixStream::pair().unwrap();
        let mut writer = FdFrameWriter::new(left);
        let mut reader = FdFrameReader::new(right);
        reader.set_first_byte_timeout(Some(Duration::from_millis(30)));

        let error = reader.read_frame(&codec).unwrap_err();
        assert!(matches!(error, TransportError::FirstByteTimeout));
        assert!(error.is_retry_safe());
        assert!(!error.desynchronizes_stream());

        writer
            .write_frame(&codec.encode(&frame("later")).unwrap())
            .unwrap();
        assert_eq!(reason(reader.read_frame(&codec).unwrap()), "later");
    }

    /// A stall that begins after the length prefix has been consumed cannot be
    /// retried, and must be reported as damage rather than as "nothing yet".
    #[test]
    fn a_stall_after_the_prefix_is_a_completion_timeout() {
        let codec = codec();
        let (mut left, right) = UnixStream::pair().unwrap();
        let mut reader = FdFrameReader::new(right);
        reader.set_first_byte_timeout(Some(Duration::from_secs(5)));
        reader.set_completion_timeout(Some(Duration::from_millis(50)));

        let encoded = codec.encode(&frame("half")).unwrap();
        left.write_all(&encoded[..4]).unwrap();
        left.flush().unwrap();

        let error = reader.read_frame(&codec).unwrap_err();
        assert!(
            matches!(error, TransportError::CompletionTimeout),
            "expected a completion timeout, got {error:?}"
        );
        assert!(error.desynchronizes_stream());
    }

    /// The property production depends on: a blocked reader must be woken from
    /// another thread, or app shutdown hangs in `join()`.
    #[test]
    fn a_self_pipe_wakes_a_reader_that_is_already_blocked() {
        let codec = codec();
        let (_left, right) = UnixStream::pair().unwrap();
        let wake = SelfPipe::new().unwrap();
        let mut reader = FdFrameReader::new(right).with_wake(Arc::clone(&wake));

        let waker = Arc::clone(&wake);
        let handle = thread::spawn(move || {
            thread::sleep(Duration::from_millis(50));
            waker.interrupt();
        });

        // No timeout is armed, so without the wake path this blocks forever.
        let error = reader.read_frame(&codec).unwrap_err();
        handle.join().unwrap();

        assert!(matches!(error, TransportError::Interrupted));
        // A detach is not damage. If this poisoned, every ordinary disconnect
        // would report a desynchronized stream.
        assert!(!error.desynchronizes_stream());
    }

    /// An interrupt raised before the read starts must still be seen, not
    /// swallowed because the byte arrived while nobody was polling.
    #[test]
    fn an_interrupt_raised_before_the_read_is_still_observed() {
        let codec = codec();
        let (_left, right) = UnixStream::pair().unwrap();
        let wake = SelfPipe::new().unwrap();
        let mut reader = FdFrameReader::new(right).with_wake(Arc::clone(&wake));

        wake.interrupt();

        assert!(matches!(
            reader.read_frame(&codec).unwrap_err(),
            TransportError::Interrupted
        ));
    }

    /// `shutdown` is how a socket-backed reader is cancelled, and it needs no
    /// second descriptor to do it.
    #[test]
    fn a_socket_interrupt_wakes_a_blocked_reader_without_a_wake_pipe() {
        let codec = codec();
        let (left, right) = UnixStream::pair().unwrap();
        let interrupt = SocketInterrupt::new(right.try_clone().unwrap());
        let mut reader = FdFrameReader::new(right);
        drop(left);

        let handle = thread::spawn(move || {
            thread::sleep(Duration::from_millis(50));
            interrupt.interrupt();
        });

        // A shutdown surfaces as a clean end of stream, not as an error: on
        // this transport a deliberate detach is indistinguishable from the
        // peer hanging up, and both mean stop.
        let outcome = reader.read_frame(&codec).unwrap();
        handle.join().unwrap();
        assert!(outcome.is_none());
    }

    #[test]
    fn a_peer_that_closes_mid_frame_is_truncation_not_a_clean_close() {
        let codec = codec();
        let (mut left, right) = UnixStream::pair().unwrap();
        let mut reader = FdFrameReader::new(right);

        let encoded = codec.encode(&frame("cut")).unwrap();
        left.write_all(&encoded[..encoded.len() - 2]).unwrap();
        left.flush().unwrap();
        drop(left);

        let error = reader.read_frame(&codec).unwrap_err();
        assert!(matches!(error, TransportError::Truncated));
        // Distinct from a clean close, but not grounds to poison: the peer
        // closed, so nothing remains that a later read could misread.
        assert!(!error.desynchronizes_stream());
    }

    #[test]
    fn a_write_to_a_dead_peer_poisons_the_writer() {
        let codec = codec();
        let (left, right) = UnixStream::pair().unwrap();
        drop(right);
        let mut writer = FdFrameWriter::new(left);

        assert!(
            writer
                .write_frame(&codec.encode(&frame("gone")).unwrap())
                .is_err()
        );
        assert!(writer.is_poisoned());
        // Once poisoned it stays refused rather than silently emitting a
        // second frame on top of a possibly half-written one.
        assert!(writer.write_frame(b"anything").is_err());
    }
}
