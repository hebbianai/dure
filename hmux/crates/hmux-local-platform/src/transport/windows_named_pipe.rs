//! Windows named-pipe carrier for the local Hmux frame protocol.
//!
//! The pipe is a byte stream, so framing and handshake semantics stay in the
//! shared protocol. This module owns only the platform facts: a local-only,
//! owner/System DACL; overlapped reads and writes with exact cancellation; and
//! a typed accept path that cannot expose a usable server transport until the
//! first bounded frame has been read and the client's token has been checked.

use super::{
    FrameReader, FrameWriter, PayloadOutcome, TransportError, TransportInterrupt,
    drive_read_payload,
};
use crate::local_peer_identity::verify_named_pipe_same_user;
use crate::peer_attestation::{ColocatedSameUserPeer, SessionScope};
use crate::windows_security::PrivateSecurityDescriptor;
use hmux_session_protocol::{DecodedFrame, FrameCodec};
use std::io::{self, Read};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
use std::path::Path;
use std::ptr::{null, null_mut};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{
    ERROR_BROKEN_PIPE, ERROR_HANDLE_EOF, ERROR_IO_PENDING, ERROR_NO_DATA, ERROR_OPERATION_ABORTED,
    ERROR_PIPE_BUSY, ERROR_PIPE_CONNECTED, ERROR_PIPE_NOT_CONNECTED, ERROR_SEM_TIMEOUT,
    GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE, WAIT_FAILED, WAIT_OBJECT_0,
    WAIT_TIMEOUT,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, OPEN_EXISTING,
    PIPE_ACCESS_DUPLEX, ReadFile, SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT, WriteFile,
};
use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
    PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT, SetNamedPipeHandleState, WaitNamedPipeW,
};
use windows_sys::Win32::System::Threading::{
    CreateEventW, INFINITE, SetEvent, WaitForMultipleObjects,
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const PIPE_BUFFER_BYTES: u32 = 64 * 1024;
const PIPE_DEFAULT_TIMEOUT_MS: u32 = 3_000;
const WRITE_OPERATION: &str = "write Hmux named pipe";

struct PipeShared {
    handle: OwnedHandle,
    interrupt_event: OwnedHandle,
    interrupted: AtomicBool,
}

impl PipeShared {
    fn new(handle: OwnedHandle) -> Result<Arc<Self>, TransportError> {
        Ok(Arc::new(Self {
            handle,
            interrupt_event: create_event("create Hmux named-pipe interrupt event")?,
            interrupted: AtomicBool::new(false),
        }))
    }

    fn raw(&self) -> HANDLE {
        self.handle.as_raw_handle().cast()
    }

    fn interrupt_raw(&self) -> HANDLE {
        self.interrupt_event.as_raw_handle().cast()
    }
}

/// A connected pipe before the caller assigns client- or server-side trust.
pub struct WindowsNamedPipeTransport {
    shared: Arc<PipeShared>,
}

impl WindowsNamedPipeTransport {
    /// Connect to a canonical local pipe address before an absolute deadline.
    pub fn connect_before(
        address: &Path,
        deadline: Option<Instant>,
    ) -> Result<Self, TransportError> {
        let encoded = encode_local_pipe_address(address)?;
        let deadline = deadline.unwrap_or_else(|| Instant::now() + CONNECT_TIMEOUT);
        loop {
            if Instant::now() >= deadline {
                return Err(TransportError::FirstByteTimeout);
            }
            // SAFETY: encoded is NUL-terminated and remains live for the call.
            // The flags request an overlapped local byte stream and allow the
            // server to identify, but never delegate as, this client token.
            let raw = unsafe {
                CreateFileW(
                    encoded.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    0,
                    null(),
                    OPEN_EXISTING,
                    FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                    null_mut(),
                )
            };
            if raw != INVALID_HANDLE_VALUE {
                // SAFETY: CreateFileW returned one owned live handle.
                let handle = unsafe { OwnedHandle::from_raw_handle(raw.cast()) };
                let mode = PIPE_READMODE_BYTE;
                // SAFETY: handle is a connected named-pipe client and mode is
                // readable for the duration of the call.
                if unsafe {
                    SetNamedPipeHandleState(
                        handle.as_raw_handle().cast(),
                        &raw const mode,
                        null(),
                        null(),
                    )
                } == 0
                {
                    return Err(io_error(
                        "set Hmux named pipe to byte mode",
                        io::Error::last_os_error(),
                    ));
                }
                return Ok(Self {
                    shared: PipeShared::new(handle)?,
                });
            }
            let source = io::Error::last_os_error();
            if source.raw_os_error()
                != Some(i32::try_from(ERROR_PIPE_BUSY).expect("Win32 error fits i32"))
            {
                return Err(io_error("connect to Hmux Host named pipe", source));
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(TransportError::FirstByteTimeout);
            }
            // SAFETY: encoded remains NUL-terminated and live for the call.
            if unsafe { WaitNamedPipeW(encoded.as_ptr(), duration_ms(remaining)) } == 0 {
                let source = io::Error::last_os_error();
                if source.raw_os_error()
                    == Some(i32::try_from(ERROR_SEM_TIMEOUT).expect("Win32 error fits i32"))
                    || Instant::now() >= deadline
                {
                    return Err(TransportError::FirstByteTimeout);
                }
                return Err(io_error("wait for Hmux Host named pipe", source));
            }
        }
    }

    #[must_use]
    pub fn raw_handle(&self) -> RawHandle {
        self.shared.handle.as_raw_handle()
    }

    #[must_use]
    pub fn into_parts(
        self,
    ) -> (
        WindowsNamedPipeFrameReader,
        WindowsNamedPipeFrameWriter,
        Arc<WindowsNamedPipeInterrupt>,
    ) {
        let interrupt = Arc::new(WindowsNamedPipeInterrupt {
            shared: Arc::clone(&self.shared),
        });
        (
            WindowsNamedPipeFrameReader::new(Arc::clone(&self.shared)),
            WindowsNamedPipeFrameWriter::new(Arc::clone(&self.shared)),
            interrupt,
        )
    }
}

/// Owns the server name and one pending instance at all times.
pub struct WindowsNamedPipeListener {
    encoded_address: Vec<u16>,
    pending: Option<OwnedHandle>,
    interrupt: Arc<ListenerInterrupt>,
}

impl WindowsNamedPipeListener {
    pub fn bind(address: &Path) -> Result<Self, TransportError> {
        let encoded_address = encode_local_pipe_address(address)?;
        let pending = create_pipe_instance(&encoded_address, true)?;
        Ok(Self {
            encoded_address,
            pending: Some(pending),
            interrupt: Arc::new(ListenerInterrupt {
                event: create_event("create Hmux named-pipe listener interrupt event")?,
                interrupted: AtomicBool::new(false),
            }),
        })
    }

    #[must_use]
    pub fn interrupt_handle(&self) -> Arc<dyn TransportInterrupt> {
        Arc::clone(&self.interrupt) as Arc<dyn TransportInterrupt>
    }

    pub fn accept_before(
        &mut self,
        deadline: Option<Instant>,
    ) -> Result<AcceptedWindowsNamedPipe, TransportError> {
        if self.interrupt.interrupted.load(Ordering::Acquire) {
            return Err(TransportError::Interrupted);
        }
        let pending = self.pending.take().ok_or_else(|| {
            io_error(
                "accept Hmux named-pipe client",
                io::Error::new(io::ErrorKind::NotConnected, "listener has no pending pipe"),
            )
        })?;
        match connect_pipe_instance(&pending, &self.interrupt, deadline) {
            Ok(()) => {
                self.pending = Some(create_pipe_instance(&self.encoded_address, false)?);
                Ok(AcceptedWindowsNamedPipe {
                    transport: WindowsNamedPipeTransport {
                        shared: PipeShared::new(pending)?,
                    },
                })
            }
            Err(error) => {
                if !self.interrupt.interrupted.load(Ordering::Acquire) {
                    self.pending = Some(create_pipe_instance(&self.encoded_address, false)?);
                }
                Err(error)
            }
        }
    }
}

struct ListenerInterrupt {
    event: OwnedHandle,
    interrupted: AtomicBool,
}

impl TransportInterrupt for ListenerInterrupt {
    fn interrupt(&self) {
        self.interrupted.store(true, Ordering::Release);
        // SAFETY: event is a live manual-reset event owned by this value.
        unsafe {
            SetEvent(self.event.as_raw_handle().cast());
        }
    }
}

/// A connected server pipe whose peer has not yet supplied any bytes.
pub struct AcceptedWindowsNamedPipe {
    transport: WindowsNamedPipeTransport,
}

impl AcceptedWindowsNamedPipe {
    /// Reads the first complete frame under one absolute admission deadline.
    /// The resulting transport still cannot be used until kernel attestation.
    pub fn read_first_frame_before(
        self,
        codec: &FrameCodec,
        deadline: Instant,
        completion_timeout: Duration,
    ) -> Result<(DecodedFrame, AttestableWindowsNamedPipe), TransportError> {
        let (mut reader, writer, interrupt) = self.transport.into_parts();
        reader.wait_readable(Some(deadline.saturating_duration_since(Instant::now())))?;
        let frame_started = reader.prefetched_at.unwrap_or_else(Instant::now);
        reader.set_completion_timeout(Some(
            deadline
                .saturating_duration_since(frame_started)
                .min(completion_timeout),
        ));
        let frame = reader.read_frame(codec)?.ok_or_else(|| {
            io_error(
                "read first Hmux named-pipe frame",
                io::Error::new(io::ErrorKind::UnexpectedEof, "client closed before Hello"),
            )
        })?;
        Ok((
            frame,
            AttestableWindowsNamedPipe {
                reader,
                writer,
                interrupt,
            },
        ))
    }
}

/// A server pipe after a bounded read made TokenUser impersonation meaningful.
pub struct AttestableWindowsNamedPipe {
    reader: WindowsNamedPipeFrameReader,
    writer: WindowsNamedPipeFrameWriter,
    interrupt: Arc<WindowsNamedPipeInterrupt>,
}

impl AttestableWindowsNamedPipe {
    pub fn verify_same_user(
        self,
        scope: SessionScope,
    ) -> Result<VerifiedWindowsNamedPipe, crate::local_peer_identity::PeerIdentityError> {
        let peer = verify_named_pipe_same_user(self.reader.shared.handle.as_raw_handle())?
            .bind_to_session(scope);
        Ok(VerifiedWindowsNamedPipe {
            reader: self.reader,
            writer: self.writer,
            interrupt: self.interrupt,
            peer,
        })
    }
}

/// A server-side pipe whose last bounded reader and peer token were verified.
pub struct VerifiedWindowsNamedPipe {
    reader: WindowsNamedPipeFrameReader,
    writer: WindowsNamedPipeFrameWriter,
    interrupt: Arc<WindowsNamedPipeInterrupt>,
    peer: ColocatedSameUserPeer,
}

impl VerifiedWindowsNamedPipe {
    #[must_use]
    pub fn into_parts(
        self,
    ) -> (
        WindowsNamedPipeFrameReader,
        WindowsNamedPipeFrameWriter,
        Arc<WindowsNamedPipeInterrupt>,
        ColocatedSameUserPeer,
    ) {
        (self.reader, self.writer, self.interrupt, self.peer)
    }
}

pub struct WindowsNamedPipeInterrupt {
    shared: Arc<PipeShared>,
}

impl TransportInterrupt for WindowsNamedPipeInterrupt {
    fn interrupt(&self) {
        self.shared.interrupted.store(true, Ordering::Release);
        // Set the explicit wake first; CancelIoEx then makes every pending
        // operation on this exact pipe generation complete as aborted.
        // SAFETY: both handles are live for the duration of the calls.
        unsafe {
            SetEvent(self.shared.interrupt_raw());
            CancelIoEx(self.shared.raw(), null());
        }
    }
}

pub struct WindowsNamedPipeFrameReader {
    shared: Arc<PipeShared>,
    completion_timeout: Option<Duration>,
    frame_started: Option<Instant>,
    prefetched: Option<u8>,
    prefetched_at: Option<Instant>,
    eof: bool,
    interrupted: bool,
}

impl WindowsNamedPipeFrameReader {
    fn new(shared: Arc<PipeShared>) -> Self {
        Self {
            shared,
            completion_timeout: None,
            frame_started: None,
            prefetched: None,
            prefetched_at: None,
            eof: false,
            interrupted: false,
        }
    }

    fn budget(&self) -> Option<Duration> {
        self.frame_started.and_then(|started| {
            self.completion_timeout
                .map(|total| total.saturating_sub(started.elapsed()))
        })
    }
}

impl Read for WindowsNamedPipeFrameReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        if let Some(byte) = self.prefetched.take() {
            buffer[0] = byte;
            self.prefetched_at = None;
            return Ok(1);
        }
        if self.eof {
            return Ok(0);
        }
        match read_once(&self.shared, buffer, self.budget())? {
            OperationOutcome::Bytes(read) => {
                if read > 0 && self.frame_started.is_none() {
                    self.frame_started = Some(Instant::now());
                }
                Ok(read)
            }
            OperationOutcome::Eof => {
                self.eof = true;
                Ok(0)
            }
            OperationOutcome::TimedOut => Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Hmux named-pipe read deadline expired",
            )),
            OperationOutcome::Interrupted => {
                self.interrupted = true;
                Err(io::Error::new(
                    io::ErrorKind::ConnectionAborted,
                    "Hmux named-pipe read was interrupted",
                ))
            }
        }
    }
}

impl FrameReader for WindowsNamedPipeFrameReader {
    fn wait_readable(&mut self, timeout: Option<Duration>) -> Result<(), TransportError> {
        if self.prefetched.is_some() || self.eof {
            return Ok(());
        }
        let mut byte = [0_u8; 1];
        match read_once(&self.shared, &mut byte, timeout).map_err(|source| TransportError::Io {
            operation: "wait for Hmux named-pipe frame",
            source,
        })? {
            OperationOutcome::Bytes(1) => {
                self.prefetched = Some(byte[0]);
                self.prefetched_at = Some(Instant::now());
                Ok(())
            }
            OperationOutcome::Bytes(_) | OperationOutcome::Eof => {
                self.eof = true;
                Ok(())
            }
            OperationOutcome::TimedOut => Err(TransportError::FirstByteTimeout),
            OperationOutcome::Interrupted => Err(TransportError::Interrupted),
        }
    }

    fn read_payload(&mut self, codec: &FrameCodec) -> Result<PayloadOutcome, TransportError> {
        self.interrupted = false;
        self.frame_started = self.prefetched_at;
        let mut progress = super::FrameProgress::new();
        let result = drive_read_payload(self, &mut progress, codec);
        self.frame_started = None;
        if self.interrupted {
            return Err(TransportError::Interrupted);
        }
        result
    }

    fn set_completion_timeout(&mut self, timeout: Option<Duration>) {
        self.completion_timeout = timeout;
    }
}

pub struct WindowsNamedPipeFrameWriter {
    shared: Arc<PipeShared>,
    poisoned: bool,
}

impl WindowsNamedPipeFrameWriter {
    fn new(shared: Arc<PipeShared>) -> Self {
        Self {
            shared,
            poisoned: false,
        }
    }

    fn write(&mut self, encoded: &[u8], deadline: Option<Instant>) -> Result<(), TransportError> {
        if self.poisoned {
            return Err(TransportError::CompletionTimeout);
        }
        let mut written = 0_usize;
        while written < encoded.len() {
            let timeout =
                deadline.map(|deadline| deadline.saturating_duration_since(Instant::now()));
            if timeout.is_some_and(|remaining| remaining.is_zero()) {
                return Err(self.write_timeout(written));
            }
            let outcome =
                write_once(&self.shared, &encoded[written..], timeout).map_err(|source| {
                    self.poisoned = true;
                    TransportError::Io {
                        operation: WRITE_OPERATION,
                        source,
                    }
                })?;
            match outcome {
                OperationOutcome::Bytes(0) | OperationOutcome::Eof => {
                    self.poisoned = true;
                    return Err(TransportError::Io {
                        operation: WRITE_OPERATION,
                        source: io::Error::new(
                            io::ErrorKind::WriteZero,
                            "failed to write the whole Hmux named-pipe frame",
                        ),
                    });
                }
                OperationOutcome::Bytes(count) => written += count,
                OperationOutcome::TimedOut => {
                    // A cancelled pending pipe write can have made a prefix
                    // visible before Windows reports zero completed bytes.
                    // The only safe outcome is to poison this carrier.
                    self.poisoned = true;
                    return Err(TransportError::CompletionTimeout);
                }
                OperationOutcome::Interrupted => {
                    self.poisoned = true;
                    return Err(TransportError::Interrupted);
                }
            }
        }
        Ok(())
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

impl FrameWriter for WindowsNamedPipeFrameWriter {
    fn write_frame(&mut self, encoded: &[u8]) -> Result<(), TransportError> {
        self.write(encoded, None)
    }

    fn write_frame_before(
        &mut self,
        encoded: &[u8],
        deadline: Option<Instant>,
    ) -> Result<(), TransportError> {
        self.write(encoded, deadline)
    }

    fn close_write(&mut self) -> Result<(), TransportError> {
        // Named pipes have no half-close. Dropping the shared handle after the
        // reader and writer finish is the only unambiguous close operation.
        Ok(())
    }
}

#[derive(Clone, Copy)]
enum OperationOutcome {
    Bytes(usize),
    Eof,
    TimedOut,
    Interrupted,
}

fn read_once(
    shared: &PipeShared,
    buffer: &mut [u8],
    timeout: Option<Duration>,
) -> io::Result<OperationOutcome> {
    if shared.interrupted.load(Ordering::Acquire) {
        return Ok(OperationOutcome::Interrupted);
    }
    let event = create_event_io()?;
    let mut overlapped = OVERLAPPED {
        hEvent: event.as_raw_handle().cast(),
        ..OVERLAPPED::default()
    };
    let requested = u32::try_from(buffer.len()).unwrap_or(u32::MAX);
    // SAFETY: every pointer remains live until complete_operation has reaped
    // this exact OVERLAPPED, including the cancellation path.
    let started = unsafe {
        ReadFile(
            shared.raw(),
            buffer.as_mut_ptr(),
            requested,
            null_mut(),
            &raw mut overlapped,
        )
    };
    complete_operation(shared, &overlapped, started, timeout, OperationKind::Read)
}

fn write_once(
    shared: &PipeShared,
    buffer: &[u8],
    timeout: Option<Duration>,
) -> io::Result<OperationOutcome> {
    if shared.interrupted.load(Ordering::Acquire) {
        return Ok(OperationOutcome::Interrupted);
    }
    let event = create_event_io()?;
    let mut overlapped = OVERLAPPED {
        hEvent: event.as_raw_handle().cast(),
        ..OVERLAPPED::default()
    };
    let requested = u32::try_from(buffer.len()).unwrap_or(u32::MAX);
    // SAFETY: every pointer remains live until complete_operation has reaped
    // this exact OVERLAPPED, including the cancellation path.
    let started = unsafe {
        WriteFile(
            shared.raw(),
            buffer.as_ptr(),
            requested,
            null_mut(),
            &raw mut overlapped,
        )
    };
    complete_operation(shared, &overlapped, started, timeout, OperationKind::Write)
}

#[derive(Clone, Copy)]
enum OperationKind {
    Read,
    Write,
}

fn complete_operation(
    shared: &PipeShared,
    overlapped: &OVERLAPPED,
    started: i32,
    timeout: Option<Duration>,
    kind: OperationKind,
) -> io::Result<OperationOutcome> {
    if started != 0 {
        return overlapped_result(shared.raw(), overlapped, false, kind);
    }
    let source = io::Error::last_os_error();
    if is_pipe_eof(&source) && matches!(kind, OperationKind::Read) {
        return Ok(OperationOutcome::Eof);
    }
    if source.raw_os_error() != Some(i32::try_from(ERROR_IO_PENDING).expect("Win32 error fits i32"))
    {
        return Err(source);
    }

    let handles = [shared.interrupt_raw(), overlapped.hEvent];
    // SAFETY: both event handles remain live throughout the wait.
    let wait = unsafe {
        WaitForMultipleObjects(
            u32::try_from(handles.len()).expect("two handles fit u32"),
            handles.as_ptr(),
            0,
            timeout.map_or(INFINITE, duration_ms),
        )
    };
    if wait == WAIT_OBJECT_0 + 1 {
        return overlapped_result(shared.raw(), overlapped, false, kind);
    }
    let requested_outcome = if wait == WAIT_OBJECT_0 {
        OperationOutcome::Interrupted
    } else if wait == WAIT_TIMEOUT {
        OperationOutcome::TimedOut
    } else if wait == WAIT_FAILED {
        let wait_error = io::Error::last_os_error();
        cancel_and_reap(shared.raw(), overlapped, kind)?;
        return Err(wait_error);
    } else {
        let wait_error = io::Error::other(format!("unexpected Windows wait result {wait}"));
        cancel_and_reap(shared.raw(), overlapped, kind)?;
        return Err(wait_error);
    };

    // SAFETY: this cancels only this stack-owned operation. Reaping below is
    // mandatory before its OVERLAPPED or buffer may leave scope.
    unsafe {
        CancelIoEx(shared.raw(), overlapped);
    }
    match overlapped_result(shared.raw(), overlapped, true, kind) {
        Ok(OperationOutcome::Bytes(count)) => {
            if matches!(requested_outcome, OperationOutcome::TimedOut) {
                // Completion won the cancellation race; no timeout consumed data.
                Ok(OperationOutcome::Bytes(count))
            } else {
                // Interrupt is terminal even when completion won the race.
                Ok(requested_outcome)
            }
        }
        Ok(OperationOutcome::Eof) => Ok(OperationOutcome::Eof),
        Ok(OperationOutcome::TimedOut | OperationOutcome::Interrupted) => Ok(requested_outcome),
        Err(source)
            if source.raw_os_error()
                == Some(i32::try_from(ERROR_OPERATION_ABORTED).expect("Win32 error fits i32")) =>
        {
            Ok(requested_outcome)
        }
        Err(source) => Err(source),
    }
}

fn cancel_and_reap(handle: HANDLE, overlapped: &OVERLAPPED, kind: OperationKind) -> io::Result<()> {
    // SAFETY: handle and OVERLAPPED identify the still-live operation.
    unsafe {
        CancelIoEx(handle, overlapped);
    }
    match overlapped_result(handle, overlapped, true, kind) {
        Ok(_) => Ok(()),
        Err(source)
            if source.raw_os_error()
                == Some(i32::try_from(ERROR_OPERATION_ABORTED).expect("Win32 error fits i32")) =>
        {
            Ok(())
        }
        Err(source) => Err(source),
    }
}

fn overlapped_result(
    handle: HANDLE,
    overlapped: &OVERLAPPED,
    wait: bool,
    kind: OperationKind,
) -> io::Result<OperationOutcome> {
    let mut transferred = 0_u32;
    // SAFETY: handle and OVERLAPPED remain live and transferred is writable.
    if unsafe { GetOverlappedResult(handle, overlapped, &raw mut transferred, i32::from(wait)) }
        != 0
    {
        return Ok(OperationOutcome::Bytes(
            usize::try_from(transferred).expect("u32 fits usize"),
        ));
    }
    let source = io::Error::last_os_error();
    if matches!(kind, OperationKind::Read) && is_pipe_eof(&source) {
        Ok(OperationOutcome::Eof)
    } else {
        Err(source)
    }
}

fn is_pipe_eof(error: &io::Error) -> bool {
    [
        ERROR_BROKEN_PIPE,
        ERROR_HANDLE_EOF,
        ERROR_NO_DATA,
        ERROR_PIPE_NOT_CONNECTED,
    ]
    .into_iter()
    .any(|code| error.raw_os_error() == Some(i32::try_from(code).expect("Win32 error fits i32")))
}

fn connect_pipe_instance(
    handle: &OwnedHandle,
    interrupt: &ListenerInterrupt,
    deadline: Option<Instant>,
) -> Result<(), TransportError> {
    let event = create_event("create Hmux named-pipe accept event")?;
    let mut overlapped = OVERLAPPED {
        hEvent: event.as_raw_handle().cast(),
        ..OVERLAPPED::default()
    };
    // SAFETY: handle is a live unconnected server pipe and overlapped remains
    // live until this function reaps or cancels the operation.
    if unsafe { ConnectNamedPipe(handle.as_raw_handle().cast(), &raw mut overlapped) } != 0 {
        return accept_outcome(interrupt);
    }
    let source = io::Error::last_os_error();
    if source.raw_os_error()
        == Some(i32::try_from(ERROR_PIPE_CONNECTED).expect("Win32 error fits i32"))
    {
        return accept_outcome(interrupt);
    }
    if source.raw_os_error() != Some(i32::try_from(ERROR_IO_PENDING).expect("Win32 error fits i32"))
    {
        return Err(io_error("accept Hmux named-pipe client", source));
    }
    let handles = [
        interrupt.event.as_raw_handle().cast(),
        event.as_raw_handle().cast(),
    ];
    let timeout = deadline
        .map(|at| duration_ms(at.saturating_duration_since(Instant::now())))
        .unwrap_or(INFINITE);
    // SAFETY: both event handles remain live for the wait.
    let wait = unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, timeout) };
    let wait_error = (wait == WAIT_FAILED).then(io::Error::last_os_error);
    if wait == WAIT_OBJECT_0 + 1 {
        let mut transferred = 0_u32;
        // SAFETY: this reaps the completed connect operation.
        if unsafe {
            GetOverlappedResult(
                handle.as_raw_handle().cast(),
                &raw const overlapped,
                &raw mut transferred,
                0,
            )
        } != 0
        {
            return accept_outcome(interrupt);
        }
        return Err(io_error(
            "finish Hmux named-pipe accept",
            io::Error::last_os_error(),
        ));
    }
    // SAFETY: cancel this exact connect and wait for its completion before the
    // stack-owned OVERLAPPED is dropped.
    unsafe {
        CancelIoEx(handle.as_raw_handle().cast(), &raw const overlapped);
        let mut transferred = 0_u32;
        GetOverlappedResult(
            handle.as_raw_handle().cast(),
            &raw const overlapped,
            &raw mut transferred,
            1,
        );
    }
    if wait == WAIT_OBJECT_0 || interrupt.interrupted.load(Ordering::Acquire) {
        Err(TransportError::Interrupted)
    } else if wait == WAIT_TIMEOUT {
        Err(TransportError::FirstByteTimeout)
    } else if let Some(source) = wait_error {
        Err(io_error("wait for Hmux named-pipe client", source))
    } else {
        Err(io_error(
            "wait for Hmux named-pipe client",
            io::Error::other(format!("unexpected Windows wait result {wait}")),
        ))
    }
}

fn accept_outcome(interrupt: &ListenerInterrupt) -> Result<(), TransportError> {
    if interrupt.interrupted.load(Ordering::Acquire) {
        Err(TransportError::Interrupted)
    } else {
        Ok(())
    }
}

fn create_pipe_instance(
    encoded_address: &[u16],
    first: bool,
) -> Result<OwnedHandle, TransportError> {
    let descriptor = PrivateSecurityDescriptor::new().map_err(|error| TransportError::Io {
        operation: "create private Hmux named-pipe security descriptor",
        source: error.into_io(),
    })?;
    let attributes = descriptor.attributes();
    let first_flag = if first {
        FILE_FLAG_FIRST_PIPE_INSTANCE
    } else {
        0
    };
    // SAFETY: address and security attributes remain live for the call. A
    // successful handle is transferred immediately into OwnedHandle.
    let raw = unsafe {
        CreateNamedPipeW(
            encoded_address.as_ptr(),
            PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | first_flag,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_UNLIMITED_INSTANCES,
            PIPE_BUFFER_BYTES,
            PIPE_BUFFER_BYTES,
            PIPE_DEFAULT_TIMEOUT_MS,
            &raw const attributes,
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        return Err(io_error(
            "bind private Hmux named pipe",
            io::Error::last_os_error(),
        ));
    }
    // SAFETY: CreateNamedPipeW returned one owned live handle.
    Ok(unsafe { OwnedHandle::from_raw_handle(raw.cast()) })
}

fn encode_local_pipe_address(address: &Path) -> Result<Vec<u16>, TransportError> {
    let Some(text) = address.to_str() else {
        return Err(invalid_address("named-pipe address is not valid Unicode"));
    };
    if !text.starts_with(r"\\.\pipe\") {
        return Err(invalid_address(
            "named-pipe address must use the local \\\\.\\pipe\\ namespace",
        ));
    }
    let mut encoded = address.as_os_str().encode_wide().collect::<Vec<_>>();
    if encoded.contains(&0) || encoded.len() > 255 {
        return Err(invalid_address(
            "named-pipe address contains NUL or exceeds 255 UTF-16 code units",
        ));
    }
    encoded.push(0);
    Ok(encoded)
}

fn invalid_address(message: &'static str) -> TransportError {
    io_error(
        "validate Hmux named-pipe address",
        io::Error::new(io::ErrorKind::InvalidInput, message),
    )
}

fn create_event(operation: &'static str) -> Result<OwnedHandle, TransportError> {
    create_event_io().map_err(|source| io_error(operation, source))
}

fn create_event_io() -> io::Result<OwnedHandle> {
    // SAFETY: no security attributes or name are supplied. The event is
    // manual-reset, initially nonsignalled, and owned by the return value.
    let raw = unsafe { CreateEventW(null(), 1, 0, null()) };
    if raw.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: CreateEventW returned one owned live handle.
    Ok(unsafe { OwnedHandle::from_raw_handle(raw.cast()) })
}

fn duration_ms(duration: Duration) -> u32 {
    if duration.is_zero() {
        return 0;
    }
    duration
        .as_millis()
        .saturating_add(u128::from(duration.subsec_nanos() % 1_000_000 != 0))
        .max(1)
        .min(u128::from(u32::MAX - 1)) as u32
}

fn io_error(operation: &'static str, source: io::Error) -> TransportError {
    TransportError::Io { operation, source }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_peer_identity::current_user_identity;
    use hmux_session_protocol::{Detach, FrameBody, FrameLimits, PROTOCOL_V1, WireFrame};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc;
    use std::thread;

    static NEXT_PIPE: AtomicU64 = AtomicU64::new(1);

    fn address(label: &str) -> std::path::PathBuf {
        let sequence = NEXT_PIPE.fetch_add(1, Ordering::Relaxed);
        format!(
            r"\\.\pipe\hmux-transport-{label}-{}-{sequence}",
            std::process::id()
        )
        .into()
    }

    fn codec() -> FrameCodec {
        FrameCodec::new(FrameLimits::default())
    }

    fn scope() -> SessionScope {
        SessionScope::new("workspace-1", "session-1", "host-1")
    }

    fn frame(id: u64, reason: &str) -> WireFrame {
        WireFrame {
            protocol_version: PROTOCOL_V1,
            frame_id: id,
            body: FrameBody::Detach(Detach {
                reason: Some(reason.into()),
            }),
        }
    }

    fn reason(decoded: DecodedFrame) -> String {
        match &decoded.frame().body {
            FrameBody::Detach(detach) => detach.reason.clone().unwrap(),
            other => panic!("unexpected frame body {other:?}"),
        }
    }

    #[test]
    fn protected_listener_attests_after_a_bounded_first_frame_and_round_trips() {
        let address = address("round-trip");
        let mut listener = WindowsNamedPipeListener::bind(&address).unwrap();
        let client_address = address.clone();
        let client = thread::spawn(move || {
            let transport = WindowsNamedPipeTransport::connect_before(
                &client_address,
                Some(Instant::now() + Duration::from_secs(2)),
            )
            .unwrap();
            let (mut reader, mut writer, _interrupt) = transport.into_parts();
            writer
                .write_frame(&codec().encode(&frame(1, "client")).unwrap())
                .unwrap();
            reason(reader.read_frame(&codec()).unwrap().unwrap())
        });

        let accepted = listener
            .accept_before(Some(Instant::now() + Duration::from_secs(2)))
            .unwrap();
        let (first, attestable) = accepted
            .read_first_frame_before(
                &codec(),
                Instant::now() + Duration::from_secs(2),
                Duration::from_secs(1),
            )
            .unwrap();
        assert_eq!(reason(first), "client");
        let verified = attestable.verify_same_user(scope()).unwrap();
        let (_reader, mut writer, _interrupt, peer) = verified.into_parts();
        assert_eq!(peer.identity(), &current_user_identity().unwrap());
        writer
            .write_frame(&codec().encode(&frame(2, "server")).unwrap())
            .unwrap();

        assert_eq!(client.join().unwrap(), "server");
    }

    #[test]
    fn first_byte_timeout_consumes_nothing_and_the_same_pipe_can_retry() {
        let address = address("retry");
        let mut listener = WindowsNamedPipeListener::bind(&address).unwrap();
        let client_address = address.clone();
        let (connected_tx, connected_rx) = mpsc::channel();
        let (write_tx, write_rx) = mpsc::channel();
        let (read_tx, read_rx) = mpsc::channel();
        let client = thread::spawn(move || {
            let transport = WindowsNamedPipeTransport::connect_before(
                &client_address,
                Some(Instant::now() + Duration::from_secs(2)),
            )
            .unwrap();
            let (_reader, mut writer, _interrupt) = transport.into_parts();
            connected_tx.send(()).unwrap();
            write_rx.recv().unwrap();
            writer
                .write_frame(&codec().encode(&frame(1, "after-timeout")).unwrap())
                .unwrap();
            read_rx.recv().unwrap();
        });
        let accepted = listener
            .accept_before(Some(Instant::now() + Duration::from_secs(2)))
            .unwrap();
        connected_rx.recv().unwrap();
        let (mut reader, _writer, _interrupt) = accepted.transport.into_parts();

        assert!(matches!(
            reader.wait_readable(Some(Duration::from_millis(20))),
            Err(TransportError::FirstByteTimeout)
        ));
        write_tx.send(()).unwrap();
        reader.wait_readable(Some(Duration::from_secs(1))).unwrap();
        assert_eq!(
            reason(reader.read_frame(&codec()).unwrap().unwrap()),
            "after-timeout"
        );
        read_tx.send(()).unwrap();
        client.join().unwrap();
    }

    #[test]
    fn expired_zero_byte_write_keeps_the_pipe_usable() {
        let address = address("write-retry");
        let mut listener = WindowsNamedPipeListener::bind(&address).unwrap();
        let client_address = address.clone();
        let (read_tx, read_rx) = mpsc::channel();
        let client = thread::spawn(move || {
            let transport = WindowsNamedPipeTransport::connect_before(
                &client_address,
                Some(Instant::now() + Duration::from_secs(2)),
            )
            .unwrap();
            let (_reader, mut writer, _interrupt) = transport.into_parts();
            let encoded = codec().encode(&frame(1, "after-write-timeout")).unwrap();
            let error = writer
                .write_frame_before(&encoded, Some(Instant::now()))
                .unwrap_err();
            assert!(matches!(error, TransportError::WriteNotStarted));
            writer.write_frame(&encoded).unwrap();
            read_rx.recv().unwrap();
        });

        let accepted = listener
            .accept_before(Some(Instant::now() + Duration::from_secs(2)))
            .unwrap();
        let (mut reader, _writer, _interrupt) = accepted.transport.into_parts();
        assert_eq!(
            reason(reader.read_frame(&codec()).unwrap().unwrap()),
            "after-write-timeout"
        );
        read_tx.send(()).unwrap();
        client.join().unwrap();
    }

    #[test]
    fn accept_timeouts_reap_pending_operations_before_retry() {
        let address = address("accept-retry");
        let mut listener = WindowsNamedPipeListener::bind(&address).unwrap();
        for _ in 0..4 {
            assert!(matches!(
                listener.accept_before(Some(Instant::now() + Duration::from_millis(5))),
                Err(TransportError::FirstByteTimeout)
            ));
        }

        let client_address = address.clone();
        let (release_tx, release_rx) = mpsc::channel();
        let client = thread::spawn(move || {
            let _transport = WindowsNamedPipeTransport::connect_before(
                &client_address,
                Some(Instant::now() + Duration::from_secs(2)),
            )
            .unwrap();
            release_rx.recv().unwrap();
        });
        let accepted = listener
            .accept_before(Some(Instant::now() + Duration::from_secs(2)))
            .unwrap();

        drop(accepted);
        release_tx.send(()).unwrap();
        client.join().unwrap();
    }

    #[test]
    fn listener_interrupt_wakes_and_reaps_a_blocked_accept() {
        let address = address("accept-interrupt");
        let mut listener = WindowsNamedPipeListener::bind(&address).unwrap();
        let interrupt = listener.interrupt_handle();
        let (started_tx, started_rx) = mpsc::channel();
        let blocked = thread::spawn(move || {
            started_tx.send(()).unwrap();
            match listener.accept_before(None) {
                Err(error) => error,
                Ok(_) => panic!("interrupted listener accepted a client"),
            }
        });
        started_rx.recv().unwrap();
        let started = Instant::now();
        interrupt.interrupt();

        assert!(matches!(
            blocked.join().unwrap(),
            TransportError::Interrupted
        ));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn interrupt_wakes_a_blocked_pipe_reader() {
        let address = address("interrupt");
        let mut listener = WindowsNamedPipeListener::bind(&address).unwrap();
        let client_address = address.clone();
        let (release_tx, release_rx) = mpsc::channel();
        let client = thread::spawn(move || {
            let _transport = WindowsNamedPipeTransport::connect_before(
                &client_address,
                Some(Instant::now() + Duration::from_secs(2)),
            )
            .unwrap();
            release_rx.recv().unwrap();
        });
        let accepted = listener
            .accept_before(Some(Instant::now() + Duration::from_secs(2)))
            .unwrap();
        let (mut reader, _writer, interrupt) = accepted.transport.into_parts();
        let (started_tx, started_rx) = mpsc::channel();
        let blocked = thread::spawn(move || {
            started_tx.send(()).unwrap();
            reader.read_frame(&codec()).unwrap_err()
        });
        started_rx.recv().unwrap();
        let started = Instant::now();
        interrupt.interrupt();

        assert!(matches!(
            blocked.join().unwrap(),
            TransportError::Interrupted
        ));
        assert!(started.elapsed() < Duration::from_secs(1));
        release_tx.send(()).unwrap();
        client.join().unwrap();
    }

    #[test]
    fn duplicate_first_listener_cannot_replace_the_bound_generation() {
        let address = address("duplicate");
        let _listener = WindowsNamedPipeListener::bind(&address).unwrap();

        assert!(matches!(
            WindowsNamedPipeListener::bind(&address),
            Err(TransportError::Io { .. })
        ));
    }

    #[test]
    fn remote_pipe_names_are_rejected_before_any_kernel_call() {
        let remote = Path::new(r"\\server\pipe\hmux-remote");

        assert!(matches!(
            WindowsNamedPipeTransport::connect_before(remote, None),
            Err(TransportError::Io { ref source, .. })
                if source.kind() == io::ErrorKind::InvalidInput
        ));
    }
}
