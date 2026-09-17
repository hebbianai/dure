use crate::terminal_attach_ui::{
    begin_synchronized_output, finish_synchronized_output, write_terminal_delta,
    write_terminal_repaint,
};
use hmux_client::{
    AttachedSessionController, ClientError, ControllerEvent, ControllerMutationHandle,
    ControllerReceiptState, LocalSessionController, ManagedAttachRequest, ManagedSessionAttacher,
    ObserverLifecycle, ScreenSnapshotDescriptor,
};
use std::error::Error;
use std::fmt;
use std::io::{self, IsTerminal, Read};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

const DETACH_PREFIX: u8 = 0x1c;
const RESIZE_POLL_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Debug)]
pub(crate) struct ManagedAttachError {
    code: String,
    message: String,
}

impl ManagedAttachError {
    pub(crate) fn client(error: ClientError) -> Self {
        Self {
            code: error.code().to_string(),
            message: error.to_string(),
        }
    }

    pub(crate) fn terminal(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    #[cfg(test)]
    pub(crate) fn code(&self) -> &str {
        &self.code
    }
}

impl fmt::Display for ManagedAttachError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl Error for ManagedAttachError {}

pub(crate) fn attach_local(
    runtime: PathBuf,
    runtime_working_directory: PathBuf,
    discovery_root: Option<&Path>,
    session_id: String,
    workspace_id: String,
) -> Result<(), Box<dyn Error>> {
    let request = ManagedAttachRequest::new(session_id.clone(), workspace_id).map_err(|error| {
        ManagedAttachError::terminal("hmux_managed_attach_request_invalid", error.to_string())
    })?;
    let mut attacher = ManagedSessionAttacher::new(runtime, runtime_working_directory);
    if let Some(root) = discovery_root {
        attacher = attacher.with_discovery_root(root);
    }
    let controller = attacher
        .attach(request)
        .map_err(ManagedAttachError::client)?;
    attach_foreground(controller, &session_id)
}

pub(crate) fn attach_standalone(session: hmux_client::LocalSession) -> Result<(), Box<dyn Error>> {
    let display_name = session
        .descriptor()
        .session_name
        .clone()
        .unwrap_or_else(|| session.descriptor().session_id.clone());
    let controller =
        LocalSessionController::connect_standalone(session).map_err(ManagedAttachError::client)?;
    attach_foreground(controller, &display_name)
}

trait ForegroundController {
    fn initial_snapshot(&self) -> &ScreenSnapshotDescriptor;
    fn lifecycle(&self) -> ObserverLifecycle;
    fn mutation_handle(&self) -> ControllerMutationHandle;
    fn read_event(&mut self) -> Result<Option<ControllerEvent>, ClientError>;
    fn set_read_timeout(&mut self, timeout: Option<Duration>) -> Result<(), ClientError>;
}

impl ForegroundController for LocalSessionController {
    fn initial_snapshot(&self) -> &ScreenSnapshotDescriptor {
        &self.attachment().initial_snapshot
    }

    fn lifecycle(&self) -> ObserverLifecycle {
        self.attachment().negotiation.lifecycle.clone()
    }

    fn mutation_handle(&self) -> ControllerMutationHandle {
        LocalSessionController::mutation_handle(self)
    }

    fn read_event(&mut self) -> Result<Option<ControllerEvent>, ClientError> {
        LocalSessionController::read_event(self)
    }

    fn set_read_timeout(&mut self, timeout: Option<Duration>) -> Result<(), ClientError> {
        LocalSessionController::set_read_timeout(self, timeout)
    }
}

impl ForegroundController for AttachedSessionController {
    fn initial_snapshot(&self) -> &ScreenSnapshotDescriptor {
        &self.attachment().initial_snapshot
    }

    fn lifecycle(&self) -> ObserverLifecycle {
        self.attachment().negotiation.lifecycle.clone()
    }

    fn mutation_handle(&self) -> ControllerMutationHandle {
        AttachedSessionController::mutation_handle(self)
    }

    fn read_event(&mut self) -> Result<Option<ControllerEvent>, ClientError> {
        AttachedSessionController::read_event(self)
    }

    fn set_read_timeout(&mut self, timeout: Option<Duration>) -> Result<(), ClientError> {
        AttachedSessionController::set_read_timeout(self, timeout)
    }
}

fn attach_foreground<C: ForegroundController>(
    mut controller: C,
    display_name: &str,
) -> Result<(), Box<dyn Error>> {
    let initial = controller.initial_snapshot();
    let terminal_size = if io::stdout().is_terminal() {
        let (columns, rows) =
            crossterm::terminal::size().unwrap_or((initial.columns, initial.rows));
        (columns.max(1), rows.max(1))
    } else {
        (initial.columns, initial.rows)
    };
    let initial_repaint = prepare_initial_repaint(&mut controller, terminal_size)?;
    write_terminal_repaint(display_name, &initial_repaint, false)?;
    if controller.lifecycle() == ObserverLifecycle::Exited {
        return Ok(());
    }

    let _raw_mode = RawModeGuard::enable_if_interactive()?;
    let mutations = controller.mutation_handle();
    let stdin_mutations = mutations.clone();
    let detach_requested = Arc::new(AtomicBool::new(false));
    let stdin_detach_requested = Arc::clone(&detach_requested);
    let _stdin = thread::spawn(move || {
        let mut stdin = io::stdin();
        let mut buffer = [0_u8; 8192];
        let mut scanner = DetachEscapeScanner::new();
        loop {
            match stdin.read(&mut buffer) {
                Ok(0) | Err(_) => {
                    if let Some(prefix) = scanner.take_pending_prefix() {
                        let _ = stdin_mutations.send_input(vec![prefix]);
                    }
                    stdin_detach_requested.store(true, Ordering::Release);
                    let _ = stdin_mutations.detach();
                    return;
                }
                Ok(size) => {
                    let outcome = scanner.scan(&buffer[..size]);
                    if !outcome.input.is_empty()
                        && stdin_mutations.send_input(outcome.input).is_err()
                    {
                        return;
                    }
                    if outcome.detach {
                        stdin_detach_requested.store(true, Ordering::Release);
                        let _ = stdin_mutations.detach();
                        return;
                    }
                }
            }
        }
    });

    let resize = ResizeTracker::new(terminal_size);
    read_updates(
        &mut controller,
        display_name,
        mutations,
        resize,
        &detach_requested,
    )
}

pub(crate) fn attach_remote_controller(
    controller: AttachedSessionController,
    display_name: &str,
) -> Result<(), Box<dyn Error>> {
    attach_foreground(controller, display_name)
}

fn prepare_initial_repaint<C: ForegroundController>(
    controller: &mut C,
    terminal_size: (u16, u16),
) -> Result<Vec<u8>, ManagedAttachError> {
    let initial = controller.initial_snapshot().clone();
    let (columns, rows) = terminal_size;
    if (initial.columns, initial.rows) == (columns, rows)
        || controller.lifecycle() == ObserverLifecycle::Exited
    {
        return Ok(initial.repaint_bytes);
    }
    let request_id = controller
        .mutation_handle()
        .resize(rows, columns)
        .map_err(ManagedAttachError::client)?;
    controller
        .set_read_timeout(Some(Duration::from_secs(1)))
        .map_err(ManagedAttachError::client)?;
    loop {
        match controller
            .read_event()
            .map_err(ManagedAttachError::client)?
        {
            Some(ControllerEvent::ResizeReceipt(receipt))
                if receipt.request_id == request_id
                    && receipt.state == ControllerReceiptState::AppliedToTerminal =>
            {
                break;
            }
            Some(ControllerEvent::ResizeReceipt(receipt)) if receipt.request_id == request_id => {
                return Err(receipt_error("initial resize", &receipt));
            }
            Some(ControllerEvent::Exit(_)) | None => return Ok(initial.repaint_bytes),
            Some(_) => {}
        }
    }
    Ok(settled_snapshot(controller, None)?.unwrap_or(initial.repaint_bytes))
}

fn settled_snapshot<C: ForegroundController>(
    controller: &mut C,
    display_name: Option<&str>,
) -> Result<Option<Vec<u8>>, ManagedAttachError> {
    let settle_started = Instant::now();
    let settle_not_before = settle_started + Duration::from_millis(120);
    let settle_deadline = settle_started + Duration::from_millis(350);
    loop {
        let remaining = settle_deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        controller
            .set_read_timeout(Some(remaining.min(Duration::from_millis(40))))
            .map_err(ManagedAttachError::client)?;
        match controller.read_event() {
            Ok(Some(ControllerEvent::Output(delta))) => {
                if let Some(name) = display_name {
                    write_terminal_delta(name, &delta.bytes).map_err(|error| {
                        ManagedAttachError::terminal("hmux_stdout_failed", error.to_string())
                    })?;
                }
            }
            Ok(Some(ControllerEvent::InputReceipt(receipt))) if receipt_failed(receipt.state) => {
                return Err(ManagedAttachError::terminal(
                    "hmux_input_failed",
                    format!(
                        "input {} was {:?} ({:?})",
                        receipt.request_id, receipt.state, receipt.reason
                    ),
                ));
            }
            Ok(Some(ControllerEvent::ResizeReceipt(receipt)))
                if receipt.state != ControllerReceiptState::AppliedToTerminal =>
            {
                return Err(receipt_error("resize", &receipt));
            }
            Ok(Some(ControllerEvent::Exit(_))) | Ok(None) => return Ok(None),
            Ok(Some(_)) => {}
            Err(error) if is_read_timeout(&error) && Instant::now() >= settle_not_before => break,
            Err(error) if is_read_timeout(&error) => {}
            Err(error) => return Err(ManagedAttachError::client(error)),
        }
    }

    let request_id = controller
        .mutation_handle()
        .request_snapshot()
        .map_err(ManagedAttachError::client)?;
    controller
        .set_read_timeout(Some(Duration::from_secs(1)))
        .map_err(ManagedAttachError::client)?;
    loop {
        match controller
            .read_event()
            .map_err(ManagedAttachError::client)?
        {
            Some(ControllerEvent::Snapshot(snapshot))
                if snapshot.in_reply_to_request_id.as_deref() == Some(&request_id) =>
            {
                controller
                    .set_read_timeout(None)
                    .map_err(ManagedAttachError::client)?;
                return Ok(Some(snapshot.repaint_bytes));
            }
            Some(ControllerEvent::Output(delta)) => {
                if let Some(name) = display_name {
                    write_terminal_delta(name, &delta.bytes).map_err(|error| {
                        ManagedAttachError::terminal("hmux_stdout_failed", error.to_string())
                    })?;
                }
            }
            Some(ControllerEvent::InputReceipt(receipt)) if receipt_failed(receipt.state) => {
                return Err(ManagedAttachError::terminal(
                    "hmux_input_failed",
                    format!(
                        "input {} was {:?} ({:?})",
                        receipt.request_id, receipt.state, receipt.reason
                    ),
                ));
            }
            Some(ControllerEvent::ResizeReceipt(receipt))
                if receipt.state != ControllerReceiptState::AppliedToTerminal =>
            {
                return Err(receipt_error("resize", &receipt));
            }
            Some(ControllerEvent::Exit(_)) | None => return Ok(None),
            Some(_) => {}
        }
    }
}

fn read_updates<C: ForegroundController>(
    controller: &mut C,
    display_name: &str,
    mutations: ControllerMutationHandle,
    mut resize: ResizeTracker,
    detach_requested: &AtomicBool,
) -> Result<(), Box<dyn Error>> {
    loop {
        resize.poll(&mutations)?;
        controller
            .set_read_timeout(Some(resize.wait_timeout()))
            .map_err(ManagedAttachError::client)?;
        match controller.read_event() {
            Ok(Some(ControllerEvent::Output(delta))) => {
                write_terminal_delta(display_name, &delta.bytes)?;
            }
            Ok(Some(ControllerEvent::Snapshot(snapshot))) => {
                write_terminal_repaint(
                    display_name,
                    &snapshot.repaint_bytes,
                    resize.synchronized_output_open(),
                )?;
            }
            Ok(Some(ControllerEvent::InputReceipt(receipt))) if receipt_failed(receipt.state) => {
                return Err(Box::new(ManagedAttachError::terminal(
                    "hmux_input_failed",
                    format!(
                        "input {} was {:?} ({:?})",
                        receipt.request_id, receipt.state, receipt.reason
                    ),
                )));
            }
            Ok(Some(ControllerEvent::ResizeReceipt(receipt)))
                if resize.owns(&receipt.request_id) =>
            {
                if receipt.state != ControllerReceiptState::AppliedToTerminal {
                    return Err(Box::new(receipt_error("resize", &receipt)));
                }
                match settled_snapshot(controller, Some(display_name)) {
                    Ok(Some(repaint)) => {
                        write_terminal_repaint(display_name, &repaint, true)?;
                        resize.complete();
                    }
                    Ok(None) => {
                        break;
                    }
                    Err(error) => return Err(Box::new(error)),
                }
            }
            Ok(Some(ControllerEvent::ResizeReceipt(receipt)))
                if receipt.state != ControllerReceiptState::AppliedToTerminal =>
            {
                return Err(Box::new(receipt_error("resize", &receipt)));
            }
            Ok(Some(ControllerEvent::ReplayGap(_))) => {
                return Err(Box::new(ManagedAttachError::terminal(
                    "hmux_replay_gap",
                    "the live attachment lost retained output; reattach for a canonical snapshot",
                )));
            }
            Ok(Some(ControllerEvent::Exit(_))) | Ok(None) => break,
            Ok(Some(_)) => {}
            Err(error)
                if error.code() == "hmux_transport_closed"
                    && detach_requested.load(Ordering::Acquire) =>
            {
                break;
            }
            Err(error) if is_read_timeout(&error) => {}
            Err(error) => return Err(Box::new(ManagedAttachError::client(error))),
        }
    }
    Ok(())
}

fn receipt_failed(state: ControllerReceiptState) -> bool {
    matches!(
        state,
        ControllerReceiptState::Refused
            | ControllerReceiptState::Revoked
            | ControllerReceiptState::Failed
    )
}

fn receipt_error(
    operation: &'static str,
    receipt: &hmux_client::ControllerResizeReceipt,
) -> ManagedAttachError {
    ManagedAttachError::terminal(
        "hmux_resize_failed",
        format!(
            "{operation} {} was {:?} ({:?})",
            receipt.request_id, receipt.state, receipt.reason
        ),
    )
}

fn is_read_timeout(error: &ClientError) -> bool {
    matches!(
        error,
        ClientError::Io { source, .. } if source.kind() == io::ErrorKind::TimedOut
    )
}

struct RawModeGuard(bool);

impl RawModeGuard {
    fn enable_if_interactive() -> io::Result<Self> {
        if io::stdin().is_terminal() && io::stdout().is_terminal() {
            crossterm::terminal::enable_raw_mode()?;
            Ok(Self(true))
        } else {
            Ok(Self(false))
        }
    }
}

impl Drop for RawModeGuard {
    fn drop(&mut self) {
        if self.0 {
            let _ = crossterm::terminal::disable_raw_mode();
        }
    }
}

struct DetachEscapeScanner {
    prefix_armed: bool,
}

struct DetachScanOutcome {
    input: Vec<u8>,
    detach: bool,
}

impl DetachEscapeScanner {
    fn new() -> Self {
        Self {
            prefix_armed: false,
        }
    }

    fn take_pending_prefix(&mut self) -> Option<u8> {
        self.prefix_armed.then(|| {
            self.prefix_armed = false;
            DETACH_PREFIX
        })
    }

    fn scan(&mut self, chunk: &[u8]) -> DetachScanOutcome {
        let mut input = Vec::with_capacity(chunk.len() + 1);
        for &byte in chunk {
            if self.prefix_armed {
                self.prefix_armed = false;
                match byte {
                    b'd' | b'D' => {
                        return DetachScanOutcome {
                            input,
                            detach: true,
                        };
                    }
                    DETACH_PREFIX => input.push(DETACH_PREFIX),
                    other => {
                        input.push(DETACH_PREFIX);
                        input.push(other);
                    }
                }
            } else if byte == DETACH_PREFIX {
                self.prefix_armed = true;
            } else {
                input.push(byte);
            }
        }
        DetachScanOutcome {
            input,
            detach: false,
        }
    }
}

struct ResizeTracker {
    terminal_size: (u16, u16),
    request_id: Option<String>,
    synchronized_output_open: bool,
    next_poll: Instant,
}

impl ResizeTracker {
    fn new(terminal_size: (u16, u16)) -> Self {
        Self {
            terminal_size,
            request_id: None,
            synchronized_output_open: false,
            next_poll: Instant::now() + RESIZE_POLL_INTERVAL,
        }
    }

    fn poll(&mut self, mutations: &ControllerMutationHandle) -> Result<(), ManagedAttachError> {
        let now = Instant::now();
        if now < self.next_poll {
            return Ok(());
        }
        self.next_poll = now + RESIZE_POLL_INTERVAL;
        if self.request_id.is_some() {
            return Ok(());
        }
        let Ok((columns, rows)) = crossterm::terminal::size() else {
            return Ok(());
        };
        let next_size = (columns.max(1), rows.max(1));
        if next_size == self.terminal_size {
            return Ok(());
        }
        begin_synchronized_output().map_err(|error| {
            ManagedAttachError::terminal("hmux_stdout_failed", error.to_string())
        })?;
        self.synchronized_output_open = true;
        let request_id = mutations
            .resize(next_size.1, next_size.0)
            .map_err(|error| {
                self.complete();
                ManagedAttachError::client(error)
            })?;
        self.terminal_size = next_size;
        self.request_id = Some(request_id);
        Ok(())
    }

    fn wait_timeout(&self) -> Duration {
        self.next_poll
            .saturating_duration_since(Instant::now())
            .max(Duration::from_millis(1))
    }

    fn owns(&self, request_id: &str) -> bool {
        self.request_id.as_deref() == Some(request_id)
    }

    fn synchronized_output_open(&self) -> bool {
        self.synchronized_output_open
    }

    fn complete(&mut self) {
        self.request_id = None;
        if self.synchronized_output_open {
            finish_synchronized_output();
            self.synchronized_output_open = false;
        }
    }
}

impl Drop for ResizeTracker {
    fn drop(&mut self) {
        self.complete();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_receipt_failures_are_fail_closed() {
        assert!(receipt_failed(ControllerReceiptState::Refused));
        assert!(receipt_failed(ControllerReceiptState::Revoked));
        assert!(receipt_failed(ControllerReceiptState::Failed));
        assert!(!receipt_failed(ControllerReceiptState::Accepted));
        assert!(!receipt_failed(ControllerReceiptState::WrittenToPty));
    }

    #[test]
    fn detach_escape_survives_split_reads() {
        let mut scanner = DetachEscapeScanner::new();
        assert!(scanner.scan(&[DETACH_PREFIX]).input.is_empty());
        assert!(scanner.scan(b"d").detach);
    }
}
