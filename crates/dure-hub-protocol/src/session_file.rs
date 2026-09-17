//! One explicit file paste, after the paired-device handshake. The receiving
//! desktop chooses the session computer and its existing private-file writer.
use crate::frame::{self, FrameError};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};

pub const MAX_FILE_BASE64_BYTES: usize = (10 * 1024 * 1024_usize).div_ceil(3) * 4;
pub const MAX_FILE_FRAME_BYTES: usize = MAX_FILE_BASE64_BYTES + 1024;
pub const MAX_RESULT_BYTES: usize = 16 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionFile {
    pub file_name: String,
    pub data_b64: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SessionFileResult {
    Saved { path: String },
    Refused { detail: String },
}

impl SessionFileResult {
    pub fn refused(detail: impl Into<String>) -> Self {
        Self::Refused {
            detail: detail.into(),
        }
    }
}

pub fn read_file(reader: &mut impl Read) -> Result<SessionFile, FrameError> {
    let file: SessionFile = frame::read(reader, MAX_FILE_FRAME_BYTES)?;
    validate(&file)?;
    Ok(file)
}

pub fn write_file(writer: &mut impl Write, file: &SessionFile) -> Result<(), String> {
    validate(file).map_err(|error| error.to_string())?;
    let bytes = frame::encode(file, MAX_FILE_FRAME_BYTES).map_err(|error| error.to_string())?;
    writer
        .write_all(&bytes)
        .and_then(|()| writer.flush())
        .map_err(|error| error.to_string())
}

fn validate(file: &SessionFile) -> Result<(), FrameError> {
    if file.file_name.is_empty() || file.file_name.len() > 255 || file.data_b64.is_empty() {
        return Err(FrameError::Malformed("Invalid file payload"));
    }
    if file.data_b64.len() > MAX_FILE_BASE64_BYTES {
        return Err(FrameError::OutOfRange {
            length: file.data_b64.len(),
            limit: MAX_FILE_BASE64_BYTES,
        });
    }
    Ok(())
}
