use crate::attach;
use crate::relay::RelayTerminalAttachment;
use crate::CommandError;
use hmux_client::transport::TransportInterrupt;
use hmux_client::{
    ConnectionRecord, TerminalSurfaceAccess, TerminalSurfaceAttachment, TerminalUpstreamHandles,
};
use hmux_host::local_protocol::FrameBody;
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::Response;

#[derive(Clone, Debug, Serialize)]
pub(crate) struct AttachedSession {
    pub session_id: String,
    pub attestation: &'static str,
    pub granted_capabilities: Vec<String>,
    pub withheld_over_relay: Vec<&'static str>,
    pub role: &'static str,
    pub terminal: AttachedTerminal,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct AttachedTerminal {
    attachment_id: String,
    terminal_epoch: String,
    through_output_seq: String,
    state_revision: String,
    initial_delivery_record_count: usize,
}

pub(crate) struct LiveAttach<T = TerminalTransport> {
    inner: Mutex<Option<ActiveAttach<T>>>,
    epochs: AtomicU64,
    requests: AtomicU64,
}

struct ActiveAttach<T> {
    epoch: u64,
    attachment_id: String,
    session_id: String,
    interrupt: Arc<dyn TransportInterrupt>,
    stopped: Arc<AtomicBool>,
    transport: T,
}

pub(crate) struct TerminalTransport {
    pull: Arc<Mutex<StructuredPull>>,
    upstream: TerminalUpstreamHandles,
}

struct StructuredPull {
    initial_records: VecDeque<Vec<u8>>,
    surface: TerminalSurfaceAttachment,
}

type StructuredPullHandle = (u64, Arc<Mutex<StructuredPull>>, Arc<AtomicBool>);

impl<T> Default for LiveAttach<T> {
    fn default() -> Self {
        Self {
            inner: Mutex::new(None),
            epochs: AtomicU64::new(0),
            requests: AtomicU64::new(0),
        }
    }
}

impl<T> LiveAttach<T> {
    pub(crate) fn begin_attach(&self) -> u64 {
        let (request, active) = {
            let mut held = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let request = self.requests.fetch_add(1, Ordering::AcqRel) + 1;
            (request, held.take())
        };
        if let Some(active) = active {
            stop_active(active);
        }
        request
    }

    pub(crate) fn stop(&self) -> Option<String> {
        let active = {
            let mut held = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            self.requests.fetch_add(1, Ordering::AcqRel);
            held.take()
        };
        active.map(stop_active)
    }

    fn stop_attachment(&self, attachment_id: &str) -> Option<String> {
        let active = {
            let mut held = self
                .inner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if held
                .as_ref()
                .is_some_and(|active| active.attachment_id == attachment_id)
            {
                self.requests.fetch_add(1, Ordering::AcqRel);
                held.take()
            } else {
                None
            }
        };
        active.map(stop_active)
    }

    fn next_epoch(&self) -> u64 {
        self.epochs.fetch_add(1, Ordering::Relaxed)
    }

    fn install(&self, request: u64, active: ActiveAttach<T>) -> Result<(), ActiveAttach<T>> {
        let mut held = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.requests.load(Ordering::Acquire) != request || held.is_some() {
            return Err(active);
        }
        *held = Some(active);
        Ok(())
    }

    fn retire(&self, epoch: u64) {
        let mut held = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if held.as_ref().is_some_and(|active| active.epoch == epoch) {
            *held = None;
        }
    }
}

impl LiveAttach {
    pub(crate) fn production() -> Self {
        Self::default()
    }

    fn terminal_pull(&self, attachment_id: &str) -> Result<StructuredPullHandle, CommandError> {
        let held = self.inner.lock().map_err(|_| attach_state_error())?;
        let active = held.as_ref().ok_or_else(|| CommandError {
            code: "terminal_not_attached".to_string(),
            message: "연결된 터미널이 없습니다".to_string(),
        })?;
        if active.attachment_id != attachment_id {
            return Err(CommandError {
                code: "terminal_attachment_changed".to_string(),
                message: "이 화면의 터미널 연결은 이미 교체되었습니다".to_string(),
            });
        }
        Ok((
            active.epoch,
            Arc::clone(&active.transport.pull),
            Arc::clone(&active.stopped),
        ))
    }

    fn terminal_upstream(
        &self,
        attachment_id: &str,
    ) -> Result<TerminalUpstreamHandles, CommandError> {
        let held = self.inner.lock().map_err(|_| attach_state_error())?;
        let active = held.as_ref().ok_or_else(|| CommandError {
            code: "terminal_not_attached".to_string(),
            message: "연결된 터미널이 없습니다".to_string(),
        })?;
        if active.attachment_id != attachment_id || active.stopped.load(Ordering::Acquire) {
            return Err(CommandError {
                code: "terminal_attachment_changed".to_string(),
                message: "이 화면의 터미널 연결은 이미 교체되었습니다".to_string(),
            });
        }
        Ok(active.transport.upstream.clone())
    }
}

fn stop_active<T>(active: ActiveAttach<T>) -> String {
    active.stopped.store(true, Ordering::Release);
    active.interrupt.interrupt();
    active.session_id
}

fn install_active<T>(
    state: &LiveAttach<T>,
    request: u64,
    active: ActiveAttach<T>,
) -> Result<(), CommandError> {
    state.install(request, active).map_err(|active| {
        stop_active(active);
        CommandError {
            code: "terminal_attach_superseded".to_string(),
            message: "더 최근의 터미널 연결 요청이 시작되었습니다".to_string(),
        }
    })
}

fn attach_state_error() -> CommandError {
    CommandError {
        code: "terminal_attach_state_failed".to_string(),
        message: "터미널 연결 상태를 읽지 못했습니다".to_string(),
    }
}

pub(crate) fn activate_terminal_surface(
    state: &LiveAttach,
    request: u64,
    session_id: String,
    access: TerminalSurfaceAccess,
    attachment: RelayTerminalAttachment,
) -> Result<AttachedSession, CommandError> {
    let initial = attachment.surface.current_frame();
    let terminal_epoch = initial.terminal_epoch().to_string();
    let through_output_seq = initial.through_output_seq().to_string();
    let state_revision = initial.state_revision().to_string();
    let initial_records = VecDeque::from(attachment.surface.initial_delivery_records().to_vec());
    let initial_delivery_record_count = initial_records.len();
    let granted_capabilities = attachment.surface.selected_capabilities().to_vec();
    let upstream = attachment.surface.upstream_handles();
    let epoch = state.next_epoch();
    let attachment_id = format!("mobile-{epoch}");
    install_active(
        state,
        request,
        ActiveAttach {
            epoch,
            attachment_id: attachment_id.clone(),
            session_id: session_id.clone(),
            interrupt: attachment.interrupt,
            stopped: Arc::new(AtomicBool::new(false)),
            transport: TerminalTransport {
                pull: Arc::new(Mutex::new(StructuredPull {
                    initial_records,
                    surface: attachment.surface,
                })),
                upstream,
            },
        },
    )?;
    Ok(AttachedSession {
        session_id,
        attestation: attachment.attestation,
        granted_capabilities,
        withheld_over_relay: attach::WITHHELD_OVER_RELAY.to_vec(),
        role: access_name(access),
        terminal: AttachedTerminal {
            attachment_id,
            terminal_epoch,
            through_output_seq,
            state_revision,
            initial_delivery_record_count,
        },
    })
}

fn access_name(access: TerminalSurfaceAccess) -> &'static str {
    match access {
        TerminalSurfaceAccess::ReadOnly => "observer",
        TerminalSurfaceAccess::Writer => "controller",
    }
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum AdapterRecord<'a> {
    Control { body: &'a FrameBody },
    Closed { code: &'a str, message: String },
}

struct PulledRecord {
    encoded: Vec<u8>,
    closed: bool,
}

fn pull_terminal_record(
    pull: &Mutex<StructuredPull>,
    stopped: &AtomicBool,
) -> Result<PulledRecord, CommandError> {
    if stopped.load(Ordering::Acquire) {
        return Err(CommandError {
            code: "terminal_attachment_retired".to_string(),
            message: "터미널 연결이 종료되었습니다".to_string(),
        });
    }
    let mut pull = pull.lock().map_err(|_| attach_state_error())?;
    if let Some(encoded) = pull.initial_records.pop_front() {
        return Ok(PulledRecord {
            encoded,
            closed: false,
        });
    }
    let record = match pull.surface.read_delivery_record() {
        Ok(record) => record,
        Err(error) => {
            let encoded = serde_json::to_vec(&AdapterRecord::Closed {
                code: error.code(),
                message: error.to_string(),
            })
            .map_err(|error| CommandError {
                code: "terminal_record_encode_failed".to_string(),
                message: error.to_string(),
            })?;
            return Ok(PulledRecord {
                encoded,
                closed: true,
            });
        }
    };
    if stopped.load(Ordering::Acquire) {
        return Err(CommandError {
            code: "terminal_attachment_retired".to_string(),
            message: "터미널 연결이 종료되었습니다".to_string(),
        });
    }
    match record {
        ConnectionRecord::TerminalState(encoded) => Ok(PulledRecord {
            encoded,
            closed: false,
        }),
        ConnectionRecord::Control(body) => {
            let closed = matches!(body.as_ref(), FrameBody::Exit(_) | FrameBody::Error(_));
            let encoded =
                serde_json::to_vec(&AdapterRecord::Control { body: &body }).map_err(|error| {
                    CommandError {
                        code: "terminal_record_encode_failed".to_string(),
                        message: error.to_string(),
                    }
                })?;
            Ok(PulledRecord { encoded, closed })
        }
    }
}

#[tauri::command]
pub(crate) async fn next_terminal_record(
    state: tauri::State<'_, LiveAttach>,
    attachment_id: String,
) -> Result<Response, CommandError> {
    let (epoch, pull, stopped) = state.terminal_pull(&attachment_id)?;
    let pulled = tauri::async_runtime::spawn_blocking(move || {
        pull_terminal_record(pull.as_ref(), stopped.as_ref())
    })
    .await
    .map_err(|error| CommandError {
        code: "terminal_pull_join_failed".to_string(),
        message: error.to_string(),
    })??;
    if pulled.closed {
        state.retire(epoch);
    }
    Ok(Response::new(pulled.encoded))
}

#[tauri::command]
pub(crate) async fn send_terminal_record(
    state: tauri::State<'_, LiveAttach>,
    attachment_id: String,
    record: Vec<u8>,
) -> Result<String, CommandError> {
    let upstream = state.terminal_upstream(&attachment_id)?;
    tauri::async_runtime::spawn_blocking(move || upstream.send_envelope(&record))
        .await
        .map_err(|error| CommandError {
            code: "terminal_send_join_failed".to_string(),
            message: error.to_string(),
        })?
        .map(|record_id| record_id.to_string())
        .map_err(|error| CommandError {
            code: error.code().to_string(),
            message: error.to_string(),
        })
}

#[tauri::command]
pub(crate) fn detach_session(
    state: tauri::State<'_, LiveAttach>,
    attachment_id: Option<String>,
) -> Option<String> {
    attachment_id.as_deref().map_or_else(
        || state.stop(),
        |attachment_id| state.stop_attachment(attachment_id),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct RecordingInterrupt {
        interrupted: AtomicBool,
    }

    impl TransportInterrupt for RecordingInterrupt {
        fn interrupt(&self) {
            self.interrupted.store(true, Ordering::SeqCst);
        }
    }

    fn candidate(
        live: &LiveAttach<()>,
        session_id: &str,
    ) -> (Arc<RecordingInterrupt>, u64, ActiveAttach<()>) {
        let interrupt = Arc::new(RecordingInterrupt::default());
        let epoch = live.next_epoch();
        let active = ActiveAttach {
            epoch,
            attachment_id: format!("mobile-{epoch}"),
            session_id: session_id.to_string(),
            interrupt: Arc::clone(&interrupt) as Arc<dyn TransportInterrupt>,
            stopped: Arc::new(AtomicBool::new(false)),
            transport: (),
        };
        (interrupt, epoch, active)
    }

    fn install(live: &LiveAttach<()>, session_id: &str) -> (Arc<RecordingInterrupt>, u64) {
        let request = live.begin_attach();
        let (interrupt, epoch, active) = candidate(live, session_id);
        assert!(install_active(live, request, active).is_ok());
        (interrupt, epoch)
    }

    #[test]
    fn stopping_interrupts_the_transport_and_clears_the_slot() {
        let live = LiveAttach::default();
        let (interrupt, _) = install(&live, "only");
        assert_eq!(live.stop(), Some("only".to_string()));
        assert!(interrupt.interrupted.load(Ordering::SeqCst));
        assert!(live.inner.lock().expect("lock").is_none());
    }

    #[test]
    fn stopping_when_nothing_is_attached_is_not_an_error() {
        assert_eq!(LiveAttach::<()>::default().stop(), None);
    }

    #[test]
    fn scoped_stop_does_not_interrupt_a_newer_attachment() {
        let live = LiveAttach::default();
        let (_, old_epoch) = install(&live, "old");
        let old_attachment_id = format!("mobile-{old_epoch}");
        let (new_interrupt, _) = install(&live, "new");

        assert_eq!(live.stop_attachment(&old_attachment_id), None);
        assert!(!new_interrupt.interrupted.load(Ordering::SeqCst));
        assert_eq!(live.stop(), Some("new".to_string()));
    }

    #[test]
    fn an_older_attach_cannot_replace_a_newer_one() {
        let live = LiveAttach::default();
        let older = live.begin_attach();
        let newer = live.begin_attach();
        let (_, _, current) = candidate(&live, "newer");
        assert!(install_active(&live, newer, current).is_ok());

        let (stale_interrupt, _, stale) = candidate(&live, "older");
        assert!(install_active(&live, older, stale).is_err());
        assert!(stale_interrupt.interrupted.load(Ordering::SeqCst));
        assert_eq!(
            live.inner
                .lock()
                .expect("lock")
                .as_ref()
                .map(|active| active.session_id.as_str()),
            Some("newer")
        );
    }

    #[test]
    fn stopping_invalidates_an_attach_still_in_flight() {
        let live = LiveAttach::default();
        let request = live.begin_attach();
        assert_eq!(live.stop(), None);

        let (interrupt, _, stale) = candidate(&live, "late");
        assert!(install_active(&live, request, stale).is_err());
        assert!(interrupt.interrupted.load(Ordering::SeqCst));
        assert!(live.inner.lock().expect("lock").is_none());
    }

    #[test]
    fn a_late_exit_does_not_retire_a_newer_attach() {
        let live = LiveAttach::default();
        let (_, first) = install(&live, "first");
        live.stop();
        install(&live, "second");
        live.retire(first);
        assert!(live.inner.lock().expect("lock").is_some());
    }

    #[test]
    fn a_re_attach_to_the_same_session_survives_the_previous_exit() {
        let live = LiveAttach::default();
        let (_, observer) = install(&live, "same-session");
        live.stop();
        install(&live, "same-session");
        live.retire(observer);
        assert!(live.inner.lock().expect("lock").is_some());
    }

    #[test]
    fn retiring_the_current_attach_clears_the_slot() {
        let live = LiveAttach::default();
        let (_, only) = install(&live, "only");
        live.retire(only);
        assert!(live.inner.lock().expect("lock").is_none());
    }
}
