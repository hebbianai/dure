//! The recording owns its frame cadence, native stream cursor and final flush.

use super::*;
use hmux_host::browser_resource::recording::BrowserRecordingLease;
use tokio::sync::watch;
use tokio::time::{Duration, MissedTickBehavior};

#[derive(Clone, Copy, PartialEq)]
enum Finish {
    Recording,
    Stop,
    Retire,
}

#[derive(Debug)]
pub(super) struct Captured {
    pub stopped: bool,
    pub closed: bool,
    pub bytes: Vec<u8>,
    pub error: Option<&'static str>,
}

#[derive(Clone)]
pub(super) struct RecordingWorker {
    finish: watch::Sender<Finish>,
    result: watch::Receiver<Option<Arc<Captured>>>,
}

impl RecordingWorker {
    pub(super) fn start(
        host: Arc<Mutex<BrowserResourceHost>>,
        changed: Arc<tokio::sync::Notify>,
        cdp: BrowserCdp,
        native: NativeRecording,
        lease: BrowserRecordingLease,
    ) -> Self {
        let (finish, requested) = watch::channel(Finish::Recording);
        let (completed, result) = watch::channel(None);
        tokio::spawn(async move {
            let captured = record(host, changed, cdp, native, lease, requested).await;
            // This is the worker's last operation; a completed observation also
            // proves the stream close and all native commands have settled.
            completed.send_replace(Some(Arc::new(captured)));
        });
        Self { finish, result }
    }

    pub(super) async fn stop(&self) -> Result<Arc<Captured>, BrowserRuntimeError> {
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

    pub(super) async fn retire(&self) {
        self.finish.send_replace(Finish::Retire);
        let _ = self.wait().await;
    }

    async fn wait(&self) -> Result<Arc<Captured>, BrowserRuntimeError> {
        let mut result = self.result.clone();
        loop {
            if let Some(result) = result.borrow_and_update().clone() {
                return Ok(result);
            }
            result
                .changed()
                .await
                .map_err(|_| BrowserEngineError::after("browser_recording_worker_interrupted"))?;
        }
    }
}

async fn frame(cdp: &mut BrowserCdp, session: &str) -> Result<(), &'static str> {
    // Native passive capture refreshes idle content once per second. The
    // record operation samples the compositor at 10fps, including a final
    // sample before stop, so short static changes enter the encoded stream.
    cdp.capture_screenshot(
        json!({"format":"jpeg","quality":1,"captureBeyondViewport":false}),
        session,
    )
    .await?;
    Ok(())
}

async fn record(
    host: Arc<Mutex<BrowserResourceHost>>,
    changed: Arc<tokio::sync::Notify>,
    mut cdp: BrowserCdp,
    native: NativeRecording,
    lease: BrowserRecordingLease,
    mut finish: watch::Receiver<Finish>,
) -> Captured {
    let mut bytes = Vec::new();
    let mut cadence = tokio::time::interval(Duration::from_millis(100));
    cadence.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut error = None;
    let mut readable = false;
    let stream_ready_deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let notification = changed.notified();
        tokio::pin!(notification);
        notification.as_mut().enable();
        if host.lock().await.recording_target(&lease).is_err() {
            error = Some("browser_recording_lifetime_changed");
            break;
        }
        tokio::select! {
            biased;
            _ = finish.changed() => break,
            _ = cadence.tick() => {},
            _ = notification => continue,
        }
        let result = async {
            host.lock()
                .await
                .recording_target(&lease)
                .map_err(|_| "browser_recording_lifetime_changed")?;
            frame(&mut cdp, &native.session).await?;
            match super::super::stream::append(
                &mut cdp,
                &native.session,
                &native.stream,
                &mut bytes,
            )
            .await
            {
                Ok(()) => {
                    readable = true;
                    Ok(())
                }
                // DevToolsStreamFile creates its file on the first encoder
                // append. Before then IO.read rejects this valid owned handle;
                // observe readiness at the next frame, within the start bound.
                // A readable stream never re-enters this initial state.
                Err(super::super::stream::StreamError::Transport(
                    "browser_cdp_stream_read_failed",
                )) if !readable
                    && bytes.is_empty()
                    && tokio::time::Instant::now() < stream_ready_deadline =>
                {
                    Ok(())
                }
                Err(error) => Err(stream_error(error)),
            }
        }
        .await;
        if let Err(code) = result {
            error = Some(code);
            break;
        }
    }
    let retiring = *finish.borrow() == Finish::Retire;
    if !retiring && error.is_none() {
        if host.lock().await.recording_target(&lease).is_ok() {
            if let Err(code) = frame(&mut cdp, &native.session).await {
                error = Some(code);
            }
        } else {
            error = Some("browser_recording_lifetime_changed");
        }
    }
    // Cleanup remains with this worker even when its caller is canceled or the
    // page retires. It never acquires input authority or retries a lost stop.
    let stopped = cdp
        .request("Page.stopScreenRecording", json!({}), Some(&native.session))
        .await;
    let stopped = stopped.is_ok_and(|value| value["stream"].as_str() == Some(&native.stream));
    let _ = host.lock().await.recording_finished(&lease, stopped);
    changed.notify_waiters();
    if !stopped {
        error = Some("browser_recording_stop_outcome_unknown");
    }
    if stopped && !retiring && error.is_none() {
        if let Err(code) = tokio::time::timeout(
            Duration::from_secs(30),
            super::super::stream::append(&mut cdp, &native.session, &native.stream, &mut bytes),
        )
        .await
        .unwrap_or(Err(super::super::stream::StreamError::Transport(
            "browser_recording_stream_timeout",
        )))
        .map_err(stream_error)
        {
            error = Some(code);
        }
    }
    let closed = cdp
        .request(
            "IO.close",
            json!({"handle":native.stream}),
            Some(&native.session),
        )
        .await
        .is_ok();
    if !closed && error.is_none() {
        error = Some("browser_recording_stream_close_failed");
    }
    if retiring {
        bytes.clear();
    }
    Captured {
        stopped,
        closed,
        bytes,
        error,
    }
}

fn stream_error(error: super::super::stream::StreamError) -> &'static str {
    match error {
        super::super::stream::StreamError::Transport(code) => code,
        super::super::stream::StreamError::Invalid => "browser_recording_stream_invalid",
        super::super::stream::StreamError::Limit => "browser_recording_byte_limit",
        super::super::stream::StreamError::Stalled => "browser_recording_stream_stalled",
    }
}

#[cfg(test)]
mod tests;
