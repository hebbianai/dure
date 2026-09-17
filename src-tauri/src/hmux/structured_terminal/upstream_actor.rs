use std::fmt;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};

use hmux_client::TerminalUpstreamHandles;
use tokio::sync::mpsc;

const MAX_QUEUED_RECORDS: usize = 512;
const MAX_QUEUED_BYTES: usize = 2 * 1024 * 1024;

pub(super) struct StructuredTerminalUpstream {
    sender: mpsc::Sender<QueuedRecord>,
    shared: Arc<UpstreamShared>,
    worker: tauri::async_runtime::JoinHandle<()>,
}

struct UpstreamShared {
    closed: AtomicBool,
    retained_records: AtomicUsize,
    retained_bytes: AtomicUsize,
    record_limit: usize,
    byte_limit: usize,
}

struct QueuedRecord {
    encoded: Vec<u8>,
    shared: Arc<UpstreamShared>,
}

impl Drop for QueuedRecord {
    fn drop(&mut self) {
        self.shared.retained_records.fetch_sub(1, Ordering::AcqRel);
        self.shared
            .retained_bytes
            .fetch_sub(self.encoded.len(), Ordering::AcqRel);
    }
}

pub(super) trait UpstreamWriter: Send + Sync + 'static {
    fn send(&self, encoded: &[u8]) -> Result<(), String>;
}

impl UpstreamWriter for TerminalUpstreamHandles {
    fn send(&self, encoded: &[u8]) -> Result<(), String> {
        self.send_envelope(encoded)
            .map(|_| ())
            .map_err(|error| format!("{}: {error}", error.code()))
    }
}

#[derive(Debug, Eq, PartialEq)]
enum AdmissionError {
    Backpressure,
    Closed,
}

impl fmt::Display for AdmissionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Backpressure => formatter.write_str(
                "hmux_structured_upstream_backpressure: structured terminal upstream queue is full",
            ),
            Self::Closed => formatter.write_str(
                "hmux_structured_upstream_closed: structured terminal upstream queue is closed",
            ),
        }
    }
}

impl StructuredTerminalUpstream {
    pub(super) fn start(
        handles: TerminalUpstreamHandles,
        on_failure: Arc<dyn Fn() + Send + Sync>,
    ) -> Self {
        Self::with_writer(
            Arc::new(handles),
            on_failure,
            MAX_QUEUED_RECORDS,
            MAX_QUEUED_BYTES,
        )
    }

    pub(super) fn with_writer(
        writer: Arc<dyn UpstreamWriter>,
        on_failure: Arc<dyn Fn() + Send + Sync>,
        record_limit: usize,
        byte_limit: usize,
    ) -> Self {
        assert!(record_limit > 0);
        let (sender, receiver) = mpsc::channel(record_limit);
        let shared = Arc::new(UpstreamShared {
            closed: AtomicBool::new(false),
            retained_records: AtomicUsize::new(0),
            retained_bytes: AtomicUsize::new(0),
            record_limit,
            byte_limit,
        });
        let worker_shared = Arc::clone(&shared);
        let worker = tauri::async_runtime::spawn(run_upstream(
            receiver,
            writer,
            worker_shared,
            on_failure,
        ));
        Self {
            sender,
            shared,
            worker,
        }
    }

    pub(super) fn enqueue(&self, encoded: Vec<u8>) -> Result<(), String> {
        let queued = match self.try_reserve(encoded) {
            Ok(queued) => queued,
            Err(error) => {
                if error == AdmissionError::Backpressure {
                    self.close();
                }
                return Err(error.to_string());
            }
        };
        match self.sender.try_send(queued) {
            Ok(()) => Ok(()),
            Err(mpsc::error::TrySendError::Full(_)) => {
                self.close();
                Err(AdmissionError::Backpressure.to_string())
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                self.close();
                Err(AdmissionError::Closed.to_string())
            }
        }
    }

    fn try_reserve(&self, encoded: Vec<u8>) -> Result<QueuedRecord, AdmissionError> {
        if self.shared.closed.load(Ordering::Acquire) {
            return Err(AdmissionError::Closed);
        }
        self.shared
            .retained_records
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                (current < self.shared.record_limit).then_some(current + 1)
            })
            .map_err(|_| AdmissionError::Backpressure)?;
        let reserved_bytes = self
            .shared
            .retained_bytes
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                current
                    .checked_add(encoded.len())
                    .filter(|next| *next <= self.shared.byte_limit)
            });
        if reserved_bytes.is_err() {
            self.shared
                .retained_records
                .fetch_sub(1, Ordering::AcqRel);
            return Err(AdmissionError::Backpressure);
        }
        if self.shared.closed.load(Ordering::Acquire) {
            self.shared
                .retained_records
                .fetch_sub(1, Ordering::AcqRel);
            self.shared
                .retained_bytes
                .fetch_sub(encoded.len(), Ordering::AcqRel);
            return Err(AdmissionError::Closed);
        }
        Ok(QueuedRecord {
            encoded,
            shared: Arc::clone(&self.shared),
        })
    }

    pub(super) fn close(&self) {
        close_shared(&self.shared);
        self.worker.abort();
    }
}

impl Drop for StructuredTerminalUpstream {
    fn drop(&mut self) {
        self.close();
    }
}

async fn run_upstream(
    mut receiver: mpsc::Receiver<QueuedRecord>,
    writer: Arc<dyn UpstreamWriter>,
    shared: Arc<UpstreamShared>,
    on_failure: Arc<dyn Fn() + Send + Sync>,
) {
    while let Some(record) = receiver.recv().await {
        if shared.closed.load(Ordering::Acquire) {
            break;
        }
        let writer = Arc::clone(&writer);
        let sent = tauri::async_runtime::spawn_blocking(move || writer.send(&record.encoded)).await;
        match sent {
            Ok(Ok(())) => {}
            Ok(Err(_)) | Err(_) => {
                close_shared(&shared);
                on_failure();
                break;
            }
        }
    }
    close_shared(&shared);
}

fn close_shared(shared: &UpstreamShared) {
    shared.closed.store(true, Ordering::Release);
}

#[cfg(test)]
mod tests {
    use std::sync::{mpsc as std_mpsc, Mutex};
    use std::time::{Duration, Instant};

    use super::*;

    struct RecordingWriter {
        sent: std_mpsc::Sender<u8>,
    }

    impl UpstreamWriter for RecordingWriter {
        fn send(&self, encoded: &[u8]) -> Result<(), String> {
            self.sent.send(encoded[0]).unwrap();
            Ok(())
        }
    }

    struct BlockingWriter {
        entered: std_mpsc::Sender<()>,
        release: Mutex<std_mpsc::Receiver<()>>,
    }

    impl UpstreamWriter for BlockingWriter {
        fn send(&self, _encoded: &[u8]) -> Result<(), String> {
            self.entered.send(()).unwrap();
            self.release.lock().unwrap().recv().unwrap();
            Ok(())
        }
    }

    #[test]
    fn burst_records_are_written_in_fifo_order() {
        let (sent_tx, sent_rx) = std_mpsc::channel();
        let actor = StructuredTerminalUpstream::with_writer(
            Arc::new(RecordingWriter { sent: sent_tx }),
            Arc::new(|| {}),
            4,
            4,
        );

        actor.enqueue(vec![1]).unwrap();
        actor.enqueue(vec![2]).unwrap();
        actor.enqueue(vec![3]).unwrap();

        assert_eq!(sent_rx.recv_timeout(Duration::from_secs(1)).unwrap(), 1);
        assert_eq!(sent_rx.recv_timeout(Duration::from_secs(1)).unwrap(), 2);
        assert_eq!(sent_rx.recv_timeout(Duration::from_secs(1)).unwrap(), 3);
    }

    #[test]
    fn blocked_writer_keeps_admission_bounded_and_close_non_blocking() {
        let (entered_tx, entered_rx) = std_mpsc::channel();
        let (release_tx, release_rx) = std_mpsc::channel();
        let actor = StructuredTerminalUpstream::with_writer(
            Arc::new(BlockingWriter {
                entered: entered_tx,
                release: Mutex::new(release_rx),
            }),
            Arc::new(|| {}),
            2,
            2,
        );
        actor.enqueue(vec![1]).unwrap();
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        actor.enqueue(vec![2]).unwrap();
        assert_eq!(
            actor.enqueue(vec![3]),
            Err(AdmissionError::Backpressure.to_string())
        );

        let started = Instant::now();
        actor.close();
        assert!(started.elapsed() < Duration::from_millis(50));
        release_tx.send(()).unwrap();
    }
}
