//! The Host owns the interval; its native connection owns the stream handles.

use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use hmux_session_protocol::browser_recording::BrowserRecordingStatus;

mod container;
mod worker;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum RecordingAction {
    Start,
    Stop,
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum RecordingFormat {
    #[default]
    Mp4,
    Webm,
}

#[derive(Clone)]
pub(super) struct NativeRecording {
    session: String,
    stream: String,
    worker: Option<worker::RecordingWorker>,
}

impl NativeRecording {
    pub(super) async fn retire(&self) {
        if let Some(worker) = &self.worker {
            worker.retire().await;
        }
    }
}

pub(super) type RecordingStreams = Arc<Mutex<BTreeMap<BrowserOperationId, NativeRecording>>>;

impl BrowserRuntime {
    pub async fn recording_state(
        &self,
        resource: &BrowserResourceIdentity,
        page: &BrowserPageId,
    ) -> Result<BrowserRecordingStatus, BrowserRuntimeError> {
        Ok(self.host.lock().await.recording_status(resource, page)?)
    }
}

impl Execution<'_> {
    pub(super) async fn record(
        &self,
        action: &BrowserActionPermit,
        command: RecordingAction,
        format: RecordingFormat,
    ) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
        self.binding.events.synchronize_events().await?;
        let starting = matches!(command, RecordingAction::Start);
        let permit = self
            .resource
            .host
            .lock()
            .await
            .prepare_recording(action, starting)?;
        let recording = permit.recording().clone();
        let mut cdp = self.binding.cdp.clone();
        let mut streams = self.binding.retirement.recordings.lock().await;
        if starting {
            // Failed stream closes remain retained until connection retirement.
            // They cannot make the resource accumulate unbounded native handles.
            if streams.len() >= 128 {
                return Err(BrowserAdmissionError::CapacityExceeded.into());
            }
            let session = cdp.attach(permit.target().as_str()).await?;
            cdp.request("Page.enable", json!({}), Some(&session))
                .await?;
            self.resource.host.lock().await.dispatch_target(action)?;
            let response = cdp
                .request(
                    "Page.startScreenRecording",
                    json!({"audio":false,"frameRate":10,"maxWidth":1920,"maxHeight":1080}),
                    Some(&session),
                )
                .await;
            let response = match response {
                Ok(response) => response,
                Err("browser_cdp_request_rejected") => {
                    return Ok(failed("browser_recording_start_rejected", false));
                }
                Err(_) => {
                    return Err(BrowserEngineError::after(
                        "browser_recording_start_outcome_unknown",
                    )
                    .into());
                }
            };
            let stream = response["stream"]
                .as_str()
                .ok_or_else(|| BrowserEngineError::after("browser_recording_stream_missing"))?
                .to_owned();
            // No await separates the native reply from retaining cleanup data.
            streams.insert(
                recording.clone(),
                NativeRecording {
                    session,
                    stream,
                    worker: None,
                },
            );
            let lease = self
                .resource
                .host
                .lock()
                .await
                .recording_acknowledged(permit)
                .map_err(|_| BrowserEngineError::after("browser_recording_start_unpublished"))?
                .expect("start acknowledgement grants capture lifetime");
            let native = streams.get_mut(&recording).unwrap();
            native.worker = Some(worker::RecordingWorker::start(
                Arc::clone(&self.resource.host),
                Arc::clone(&self.resource.changed),
                cdp,
                native.clone(),
                lease,
            ));
            return Ok(NativeBrowserResponse {
                id: "browser-record-start".into(),
                success: true,
                data: json!({"recording_operation_id":recording,"started":true,"mime_type":"video/mp4"}),
                error: None,
            });
        }

        let native = streams
            .get(&recording)
            .ok_or_else(|| BrowserEngineError::after("browser_recording_owner_missing"))?
            .clone();
        self.resource.host.lock().await.dispatch_target(action)?;
        let captured = native
            .worker
            .as_ref()
            .ok_or_else(|| BrowserEngineError::after("browser_recording_worker_missing"))?
            .stop()
            .await?;
        if !captured.stopped {
            return Err(BrowserEngineError::after("browser_recording_stop_outcome_unknown").into());
        }
        self.resource
            .host
            .lock()
            .await
            .recording_acknowledged(permit)
            .map_err(|_| BrowserEngineError::after("browser_recording_stop_unpublished"))?;
        if captured.closed {
            streams.remove(&recording);
        }
        // Stop is acknowledged. Capture/read errors stay completed failures.
        let bytes = match captured.error {
            Some(code) => Err(code),
            None => Ok(&captured.bytes),
        };
        let mut response = match bytes {
            Ok(bytes) if bytes.get(4..8) == Some(b"ftyp") => {
                let exported = match format {
                    RecordingFormat::Webm => container::webm(bytes)
                        .map(|bytes| ("video/webm", "recording.webm", STANDARD.encode(bytes))),
                    RecordingFormat::Mp4 => {
                        Ok(("video/mp4", "recording.mp4", STANDARD.encode(bytes)))
                    }
                };
                match exported {
                    Ok((mime, filename, base64)) => NativeBrowserResponse {
                        id: "browser-record-stop".into(),
                        success: true,
                        data: json!({"stopped":true,"artifact_payload":{"mime_type":mime,"suggested_filename":filename,"base64":base64}}),
                        error: None,
                    },
                    Err(code) => failed(code, true),
                }
            }
            Ok(_) => failed("browser_recording_invalid", true),
            Err(code) => failed(code, true),
        };
        response.data["recording_operation_id"] = json!(recording);
        Ok(response)
    }
}

fn failed(code: &str, stopped: bool) -> NativeBrowserResponse {
    NativeBrowserResponse {
        id: "browser-record".into(),
        success: false,
        data: json!({"stopped":stopped}),
        error: Some(code.into()),
    }
}
