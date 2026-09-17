//! One retained native owner for both Chromium tracing transfer modes.
//! The caller must admit the browser-instance data scope before construction.

use super::*;
use crate::browser_engine::chromium::ChromiumConnection;
use tokio::sync::watch;

mod action;
mod document;
mod worker;
pub(super) use action::TracingAction;

#[derive(Clone, Debug)]
pub(super) enum TraceMode {
    Trace,
    Profiler { categories: Option<Vec<String>> },
}

impl TraceMode {
    fn parameters(&self) -> Value {
        match self {
            Self::Trace => {
                json!({"transferMode":"ReturnAsStream","traceConfig":{"recordMode":"recordContinuously"}})
            }
            Self::Profiler { categories } => {
                let defaults = [
                    "devtools.timeline",
                    "disabled-by-default-devtools.timeline",
                    "disabled-by-default-devtools.timeline.frame",
                    "disabled-by-default-devtools.timeline.stack",
                    "v8.execute",
                    "disabled-by-default-v8.cpu_profiler",
                    "disabled-by-default-v8.cpu_profiler.hires",
                    "v8",
                    "disabled-by-default-v8.runtime_stats",
                    "blink",
                    "blink.user_timing",
                    "latencyInfo",
                    "renderer.scheduler",
                    "sequence_manager",
                    "toplevel",
                ];
                json!({"transferMode":"ReportEvents","traceConfig":{"enableSampling":true,"includedCategories":categories.as_ref().map_or_else(||json!(defaults),|value|json!(value))}})
            }
        }
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum Finish {
    Recording,
    Stop,
    Retire,
}

#[derive(Debug)]
pub(super) struct TraceResult {
    pub start_sent: bool,
    pub started: bool,
    pub ended: bool,
    pub stream_closed: bool,
    pub bytes: Vec<u8>,
    pub event_count: usize,
    pub data_loss: bool,
    pub error: Option<&'static str>,
}

impl TraceResult {
    pub(super) fn cleanup_confirmed(&self) -> bool {
        !self.start_sent
            || (!self.started && self.error == Some("browser_cdp_request_rejected"))
            || (self.ended && self.stream_closed)
    }
}

#[derive(Clone)]
pub(super) struct NativeTracing {
    finish: watch::Sender<Finish>,
    started: watch::Receiver<Option<Result<(), &'static str>>>,
    result: watch::Receiver<Option<Arc<TraceResult>>>,
}

impl NativeTracing {
    pub(super) fn completed(&self) -> Option<Arc<TraceResult>> {
        self.result.borrow().clone()
    }
    /// Return cleanup ownership before any native request can be acknowledged.
    /// Waiting for start or stop never owns the worker's lifetime.
    pub(super) fn spawn(
        connection: ChromiumConnection,
        target: BrowserTargetId,
        mode: TraceMode,
    ) -> Self {
        let (finish, requested) = watch::channel(Finish::Recording);
        let (startup, started) = watch::channel(None);
        let (completed, result) = watch::channel(None);
        tokio::spawn(async move {
            let captured = worker::run(connection, target, mode, requested, &startup).await;
            if startup.borrow().is_none() {
                startup.send_replace(Some(Err(captured
                    .error
                    .unwrap_or("browser_trace_interrupted"))));
            }
            completed.send_replace(Some(Arc::new(captured)));
        });
        Self {
            finish,
            started,
            result,
        }
    }

    pub(super) async fn started(&self) -> Result<(), &'static str> {
        let mut started = self.started.clone();
        loop {
            if let Some(value) = *started.borrow_and_update() {
                return value;
            }
            started
                .changed()
                .await
                .map_err(|_| "browser_trace_worker_interrupted")?;
        }
    }

    pub(super) async fn stop(&self) -> Result<Arc<TraceResult>, &'static str> {
        self.finish.send_if_modified(|value| {
            if *value == Finish::Recording {
                *value = Finish::Stop;
                true
            } else {
                false
            }
        });
        self.wait().await
    }

    pub(super) async fn retire(&self) -> Result<Arc<TraceResult>, &'static str> {
        self.finish.send_replace(Finish::Retire);
        self.wait().await
    }

    async fn wait(&self) -> Result<Arc<TraceResult>, &'static str> {
        let mut result = self.result.clone();
        loop {
            if let Some(value) = result.borrow_and_update().clone() {
                return Ok(value);
            }
            result
                .changed()
                .await
                .map_err(|_| "browser_trace_worker_interrupted")?;
        }
    }
}
