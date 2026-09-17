//! Immutable result payloads supplement the existing operation journal. A file
//! alone never establishes completion or authorizes recovery of browser input.

use super::{BackendDispatchError, OperationIdV1};
use crate::browser_engine::runtime::capture::{CapturedFile, MAX_ARTIFACT_BYTES};
use base64::{Engine, engine::general_purpose::STANDARD};
use dure_app::{OperationReceiptStateV1, OperationReceiptV1};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

const MAX_RESULT_BYTES: usize = 1024 * 1024;
const CHUNK_BYTES: usize = 64 * 1024;

#[derive(Clone)]
pub(super) struct BrowserResults(PathBuf);

#[derive(Serialize, Deserialize)]
struct Payload {
    fingerprint: String,
    result: Option<Value>,
    error: Option<Value>,
}

impl BrowserResults {
    pub(super) fn new(root: &Path) -> Self {
        Self(root.to_owned())
    }

    fn directory(&self) -> Result<PathBuf, BackendDispatchError> {
        crate::ensure_owner_subdirectory(&self.0, "browser-results").map_err(|_| failure())
    }

    fn path(
        &self,
        operation: &OperationIdV1,
        suffix: &str,
    ) -> Result<PathBuf, BackendDispatchError> {
        Ok(self.directory()?.join(format!(
            "{:x}.{suffix}",
            Sha256::digest(operation.as_str().as_bytes())
        )))
    }

    pub(super) async fn capture_response(
        &self,
        operation: OperationIdV1,
        page: &hmux_session_protocol::browser_resource::BrowserPageIdentity,
        result: &mut crate::browser_engine::runtime::BrowserActionResult,
    ) -> Result<(), BackendDispatchError> {
        if let Some(payload) = result
            .response
            .data
            .get_mut("artifact_payload")
            .map(Value::take)
        {
            let file = CapturedFile {
                page: page.clone(),
                mime_type: match payload["mime_type"].as_str() {
                    Some("video/mp4") => "video/mp4",
                    Some("video/webm") => "video/webm",
                    Some("application/pdf") => "application/pdf",
                    Some("application/json") => "application/json",
                    Some("application/octet-stream") => "application/octet-stream",
                    _ => {
                        return Err(BackendDispatchError::terminal("browser_artifact_invalid"));
                    }
                },
                suggested_filename: payload["suggested_filename"].as_str().map(String::from),
                bytes: STANDARD
                    .decode(payload["base64"].as_str().ok_or_else(|| {
                        BackendDispatchError::terminal("browser_artifact_invalid")
                    })?)
                    .map_err(|_| BackendDispatchError::terminal("browser_artifact_invalid"))?,
            };
            let artifact = self.capture(operation, file).await?;
            result
                .response
                .data
                .as_object_mut()
                .expect("artifact response object")
                .remove("artifact_payload");
            result.response.data["artifact"] = json!(artifact);
        }
        Ok(())
    }

    pub(super) async fn capture(
        &self,
        operation: OperationIdV1,
        file: CapturedFile,
    ) -> Result<Value, BackendDispatchError> {
        let results = self.clone();
        tokio::task::spawn_blocking(move || {
            if file.bytes.len() > MAX_ARTIFACT_BYTES {
                return Err(BackendDispatchError::terminal(
                    "browser_artifact_byte_limit",
                ));
            }
            let mut manifest = json!({"page":file.page,"mimeType":file.mime_type,
                "size":file.bytes.len(),"sha256":format!("{:x}",Sha256::digest(&file.bytes))});
            if let Some(name) = file.suggested_filename {
                manifest["suggestedFilename"] = name.into();
            }
            publish(&results.path(&operation, "artifact")?, &file.bytes)?;
            Ok(manifest)
        })
        .await
        .map_err(|_| failure())?
    }

    pub(super) async fn save(
        &self,
        operation: &OperationIdV1,
        fingerprint: &str,
        result: &Result<Value, BackendDispatchError>,
    ) -> Result<(), BackendDispatchError> {
        let payload = Payload {
            fingerprint: fingerprint.into(),
            result: result.as_ref().ok().cloned(),
            error: result
                .as_ref()
                .err()
                .map(|error| json!({"code":error.code})),
        };
        let bytes = serde_json::to_vec(&payload).map_err(|_| failure())?;
        if bytes.len() > MAX_RESULT_BYTES {
            return Err(BackendDispatchError::terminal("browser_result_byte_limit"));
        }
        let path = self.path(operation, "json")?;
        tokio::task::spawn_blocking(move || publish(&path, &bytes))
            .await
            .map_err(|_| failure())?
    }

    fn payload(
        &self,
        receipt: &OperationReceiptV1,
    ) -> Result<Option<Payload>, BackendDispatchError> {
        if receipt.state == OperationReceiptStateV1::Running {
            return Ok(None);
        }
        let path = self.path(&receipt.operation_id, "json")?;
        let file = match open(&path, MAX_RESULT_BYTES) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(failure()),
        };
        let payload: Payload = serde_json::from_reader(file).map_err(|_| failure())?;
        if payload.fingerprint != receipt.idempotency_key {
            return Err(BackendDispatchError::terminal("browser_operation_conflict"));
        }
        Ok(Some(payload))
    }

    pub(super) fn recover(
        &self,
        receipt: &OperationReceiptV1,
    ) -> Result<Value, BackendDispatchError> {
        let payload = self.payload(receipt)?;
        Ok(
            json!({"operation_id":receipt.operation_id,"receipt":receipt,
            "result_available":payload.is_some(),
            "result":payload.as_ref().and_then(|payload|payload.result.as_ref()),
            "error":payload.as_ref().and_then(|payload|payload.error.as_ref())}),
        )
    }

    pub(super) fn chunk(
        &self,
        receipt: &OperationReceiptV1,
        offset: u64,
    ) -> Result<Value, BackendDispatchError> {
        if receipt.state != OperationReceiptStateV1::Succeeded {
            return Err(BackendDispatchError::terminal(
                "browser_artifact_unavailable",
            ));
        }
        let result = self
            .payload(receipt)?
            .and_then(|payload| payload.result)
            .ok_or_else(|| BackendDispatchError::terminal("browser_artifact_unavailable"))?;
        let manifest = result
            .get("artifact")
            .or_else(|| result.pointer("/response/data/artifact"))
            .ok_or_else(|| BackendDispatchError::terminal("browser_artifact_unavailable"))?;
        let size = manifest["size"]
            .as_u64()
            .filter(|size| *size <= MAX_ARTIFACT_BYTES as u64)
            .ok_or_else(failure)?;
        if offset > size {
            return Err(BackendDispatchError::terminal(
                "browser_artifact_offset_invalid",
            ));
        }
        let mut file = open(
            &self.path(&receipt.operation_id, "artifact")?,
            MAX_ARTIFACT_BYTES,
        )
        .map_err(|_| failure())?;
        if file.metadata().map_err(|_| failure())?.len() != size {
            return Err(failure());
        }
        file.seek(SeekFrom::Start(offset)).map_err(|_| failure())?;
        let mut bytes = vec![0; CHUNK_BYTES.min((size - offset) as usize)];
        file.read_exact(&mut bytes).map_err(|_| failure())?;
        Ok(
            json!({"artifact":manifest,"offset":offset,"base64":STANDARD.encode(&bytes),"eof":offset+bytes.len() as u64==size}),
        )
    }
}

fn failure() -> BackendDispatchError {
    BackendDispatchError::terminal("browser_result_unavailable")
}

fn open(path: &Path, limit: usize) -> std::io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
        || metadata.len() > limit as u64
    {
        return Err(std::io::Error::other("invalid browser result file"));
    }
    Ok(file)
}

fn publish(path: &Path, bytes: &[u8]) -> Result<(), BackendDispatchError> {
    let parent = path.parent().ok_or_else(failure)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|_| failure())?;
    temporary.write_all(bytes).map_err(|_| failure())?;
    temporary.as_file().sync_all().map_err(|_| failure())?;
    temporary.persist_noclobber(path).map_err(|_| failure())?;
    File::open(parent)
        .and_then(|file| file.sync_all())
        .map_err(|_| failure())
}
