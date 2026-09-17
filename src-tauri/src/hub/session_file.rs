//! Authenticated file staging through the desktop's existing session location
//! and private-file transfer owners. No path or SSH destination comes from the phone.
use dure_hub_protocol::frame;
use dure_hub_protocol::session_file::{self, SessionFile, SessionFileResult};
use serde::Serialize;
use std::io::{Read, Write};

#[derive(Clone, Serialize)]
pub struct SessionFileRequest {
    pub session_id: String,
    pub file: SessionFile,
}

pub trait SessionFileSink: Send + Sync {
    fn deliver(&self, request: SessionFileRequest) -> SessionFileResult;
}

impl super::roundtrip::RoundTrip for SessionFileResult {
    const PREFIX: &'static str = "session-file";
    const EVENT: &'static str = "hub://session-file";
    fn undeliverable() -> Self {
        Self::refused("The desktop could not receive the file")
    }
    fn timed_out() -> Self {
        Self::refused("The desktop did not return a file path")
    }
}

pub(super) fn serve(
    stream: &mut (impl Read + Write),
    session_id: String,
    sink: Option<&dyn SessionFileSink>,
) {
    let result = match session_file::read_file(stream) {
        Ok(file) => match sink {
            Some(sink) => sink.deliver(SessionFileRequest { session_id, file }),
            None => SessionFileResult::refused("This desktop cannot receive pasted files"),
        },
        Err(error) => SessionFileResult::refused(error.to_string()),
    };
    if let Ok(bytes) = frame::encode(&result, session_file::MAX_RESULT_BYTES) {
        let _ = stream.write_all(&bytes).and_then(|()| stream.flush());
    }
}

#[tauri::command]
pub fn hub_session_file_result(
    state: tauri::State<'_, super::commands::HubState>,
    request_id: String,
    reply: SessionFileResult,
) -> bool {
    state.pending_file.settle(&request_id, reply)
}

#[cfg(test)]
#[path = "session_file_tests.rs"]
mod tests;
