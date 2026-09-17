//! Pasted bytes use the paired Hub transport; terminal input still uses the
//! original controller attachment and its Host input fence.
use crate::hub_client::{self, HubClientError};
use dure_hub_protocol::{
    frame,
    hello::HubRequest,
    session_file::{self, SessionFile, SessionFileResult},
};
use std::io::{Read, Write};

fn stage_on_stream(
    stream: &mut (impl Read + Write),
    token: &str,
    session_id: String,
    file: &SessionFile,
) -> Result<SessionFileResult, HubClientError> {
    hub_client::handshake_for(stream, token, HubRequest::StageSessionFileV1 { session_id })?;
    session_file::write_file(stream, file).map_err(HubClientError::Protocol)?;
    frame::read(stream, session_file::MAX_RESULT_BYTES)
        .map_err(|error| HubClientError::Protocol(error.to_string()))
}

#[tauri::command]
pub async fn hub_stage_session_file(
    app: tauri::AppHandle,
    id: String,
    session_id: String,
    file: SessionFile,
) -> Result<Vec<String>, crate::CommandError> {
    let entry = crate::hub_target(&app, &id)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let relay = entry
            .relay_endpoint
            .as_deref()
            .zip(entry.server_id.as_deref());
        let mut stream = hub_client::dial_tls(&entry.endpoint, relay, &entry.fingerprint)?;
        stage_on_stream(&mut stream, &entry.token, session_id, &file)
    })
    .await
    .map_err(|error| crate::CommandError {
        code: "hub_join".into(),
        message: error.to_string(),
    })?
    .map_err(|error| crate::CommandError {
        code: error.code().into(),
        message: error.to_string(),
    })?;
    match result {
        SessionFileResult::Saved { path } => Ok(vec![path]),
        SessionFileResult::Refused { detail } => Err(crate::CommandError {
            code: "session_file_refused".into(),
            message: detail,
        }),
    }
}
