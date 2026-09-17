//! Resource-owned upload bytes. The Host still exclusively admits page input;
//! staging a file neither acquires a controller nor mutates the page.

use super::find::finish_element_result;
use super::{
    BrowserActionPermit, BrowserCdp, BrowserElementTarget, BrowserRuntimeError, Execution,
};
use crate::browser_engine::{NativeBrowserEngine, NativeBrowserResponse};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tokio::fs::{File, OpenOptions};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

pub(super) const MAX_FILES: usize = 16;
const MAX_BYTES: u64 = 64 * 1024 * 1024;
const CHUNK_BYTES: usize = 64 * 1024;
const RESOURCE_BYTES: u64 = 256 * 1024 * 1024;
const RESOURCE_FILES: usize = 128;

use super::BrowserRuntime;
#[cfg(test)]
mod tests;

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(try_from = "FileManifest")]
pub struct BrowserUploadFile(FileManifest);

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct FileManifest {
    name: String,
    size: u64,
    sha256: String,
}

impl TryFrom<FileManifest> for BrowserUploadFile {
    type Error = &'static str;
    fn try_from(file: FileManifest) -> Result<Self, Self::Error> {
        if file.name.is_empty()
            || file.name.len() > 255
            || [".", ".."].contains(&file.name.as_str())
            || file.name.contains(['/', '\\', '\0'])
            || file.size > MAX_BYTES
            || !digest_valid(&file.sha256)
        {
            return Err("browser_upload_manifest_invalid");
        }
        Ok(Self(file))
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq, Ord, PartialOrd)]
#[serde(try_from = "String")]
pub struct BrowserUploadId(String);

impl TryFrom<String> for BrowserUploadId {
    type Error = &'static str;
    fn try_from(id: String) -> Result<Self, Self::Error> {
        if !digest_valid(&id) {
            return Err("browser_upload_id_invalid");
        }
        Ok(Self(id))
    }
}

fn digest_valid(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[derive(Debug, Deserialize)]
#[serde(try_from = "RawChunk")]
pub struct BrowserUploadChunk {
    file: BrowserUploadFile,
    offset: u64,
    bytes: Vec<u8>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawChunk {
    file: BrowserUploadFile,
    offset: u64,
    base64: String,
}

impl TryFrom<RawChunk> for BrowserUploadChunk {
    type Error = &'static str;
    fn try_from(raw: RawChunk) -> Result<Self, Self::Error> {
        if raw.base64.len() > 4 * CHUNK_BYTES.div_ceil(3) {
            return Err("browser_upload_chunk_invalid");
        }
        let bytes = STANDARD
            .decode(&raw.base64)
            .map_err(|_| "browser_upload_chunk_invalid")?;
        if bytes.len() > CHUNK_BYTES
            || raw.offset > raw.file.0.size
            || bytes.len() as u64 > raw.file.0.size - raw.offset
            || (bytes.is_empty() && raw.file.0.size != 0)
        {
            return Err("browser_upload_chunk_invalid");
        }
        Ok(Self {
            file: raw.file,
            offset: raw.offset,
            bytes,
        })
    }
}

struct StoredFile {
    _directory: tempfile::TempDir,
    path: PathBuf,
    file: File,
    manifest: BrowserUploadFile,
    received: u64,
    hash: Sha256,
    sealed: bool,
}

pub(super) struct BrowserUploads {
    root: PathBuf,
    files: BTreeMap<BrowserUploadId, StoredFile>,
}

impl BrowserUploads {
    pub(super) fn new(root: &Path) -> Self {
        Self {
            root: root.to_owned(),
            files: BTreeMap::new(),
        }
    }

    pub(super) async fn stage(&mut self, chunk: BrowserUploadChunk) -> Result<Value, &'static str> {
        let id = BrowserUploadId(format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&chunk.file).map_err(|_| "browser_upload_manifest_invalid")?
            )
        ));
        if !self.files.contains_key(&id) {
            if chunk.offset != 0 {
                return Err("browser_upload_offset_invalid");
            }
            if self.files.len() >= RESOURCE_FILES
                || self
                    .files
                    .values()
                    .map(|file| file.manifest.0.size)
                    .sum::<u64>()
                    + chunk.file.0.size
                    > RESOURCE_BYTES
            {
                return Err("browser_upload_resource_limit");
            }
            let directory = tempfile::Builder::new()
                .prefix("upload-")
                .tempdir_in(&self.root)
                .map_err(|_| "browser_upload_storage_unavailable")?;
            let path = directory.path().join(&chunk.file.0.name);
            let file = OpenOptions::new()
                .create_new(true)
                .read(true)
                .write(true)
                .mode(0o600)
                .open(&path)
                .await
                .map_err(|_| "browser_upload_storage_unavailable")?;
            self.files.insert(
                id.clone(),
                StoredFile {
                    _directory: directory,
                    path,
                    file,
                    manifest: chunk.file.clone(),
                    received: 0,
                    hash: Sha256::new(),
                    sealed: false,
                },
            );
        }
        let file = self.files.get_mut(&id).expect("inserted upload");
        if file.manifest != chunk.file {
            return Err("browser_upload_manifest_invalid");
        }
        if chunk.offset > file.received {
            return Err("browser_upload_offset_invalid");
        }
        file.file
            .seek(std::io::SeekFrom::Start(chunk.offset))
            .await
            .map_err(|_| "browser_upload_storage_unavailable")?;
        if chunk.offset < file.received || file.sealed {
            if chunk.offset + chunk.bytes.len() as u64 > file.received {
                return Err("browser_upload_offset_invalid");
            }
            let mut previous = vec![0; chunk.bytes.len()];
            file.file
                .read_exact(&mut previous)
                .await
                .map_err(|_| "browser_upload_storage_unavailable")?;
            if previous != chunk.bytes {
                return Err("browser_upload_chunk_conflict");
            }
        } else {
            file.file
                .write_all(&chunk.bytes)
                .await
                .map_err(|_| "browser_upload_storage_unavailable")?;
            file.hash.update(&chunk.bytes);
            file.received += chunk.bytes.len() as u64;
        }
        if !file.sealed && file.received == file.manifest.0.size {
            if format!("{:x}", file.hash.clone().finalize()) != file.manifest.0.sha256 {
                self.files.remove(&id);
                return Err("browser_upload_digest_mismatch");
            }
            file.file
                .sync_all()
                .await
                .map_err(|_| "browser_upload_storage_unavailable")?;
            file.sealed = true;
        }
        Ok(json!({"id":id,"file":file.manifest,"received":file.received,"complete":file.sealed}))
    }

    fn sealed(
        &self,
        ids: &[BrowserUploadId],
    ) -> Result<(Vec<PathBuf>, Vec<BrowserUploadFile>), &'static str> {
        if ids.is_empty() || ids.len() > MAX_FILES {
            return Err("browser_upload_files_invalid");
        }
        let mut paths = Vec::new();
        let mut manifests = Vec::new();
        let mut size = 0;
        for id in ids {
            let file = self
                .files
                .get(id)
                .filter(|file| file.sealed)
                .ok_or("browser_upload_incomplete")?;
            size += file.manifest.0.size;
            if size > MAX_BYTES {
                return Err("browser_upload_byte_limit");
            }
            paths.push(file.path.clone());
            manifests.push(file.manifest.clone());
        }
        Ok((paths, manifests))
    }

    pub(super) fn clear(&mut self) {
        self.files.clear();
    }

    pub(super) async fn read_sealed(
        &mut self,
        id: &BrowserUploadId,
    ) -> Result<Vec<u8>, &'static str> {
        self.read_sealed_with_limit(id, MAX_BYTES).await
    }

    pub(super) async fn read_sealed_with_limit(
        &mut self,
        id: &BrowserUploadId,
        maximum: u64,
    ) -> Result<Vec<u8>, &'static str> {
        let file = self
            .files
            .get_mut(id)
            .filter(|file| file.sealed)
            .ok_or("browser_upload_incomplete")?;
        if file.manifest.0.size > maximum {
            return Err("browser_upload_byte_limit");
        }
        file.file
            .seek(std::io::SeekFrom::Start(0))
            .await
            .map_err(|_| "browser_upload_storage_unavailable")?;
        let mut bytes = Vec::new();
        (&mut file.file)
            .take(file.manifest.0.size + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| "browser_upload_storage_unavailable")?;
        if bytes.len() as u64 != file.manifest.0.size
            || format!("{:x}", Sha256::digest(&bytes)) != file.manifest.0.sha256
        {
            return Err("browser_upload_file_changed");
        }
        Ok(bytes)
    }
}

impl BrowserRuntime {
    pub async fn stage_upload(
        &self,
        chunk: BrowserUploadChunk,
    ) -> Result<Value, BrowserRuntimeError> {
        let mut uploads = self.uploads.lock().await;
        let control = self.host.lock().await.projection();
        if matches!(
            control.phase,
            hmux_session_protocol::browser_resource::BrowserResourcePhase::Retiring
                | hmux_session_protocol::browser_resource::BrowserResourcePhase::Closed
        ) {
            return Err("browser_resource_retiring".into());
        }
        Ok(uploads.stage(chunk).await?)
    }
}

impl Execution<'_> {
    pub(super) async fn upload_action(
        &self,
        engine: &mut NativeBrowserEngine,
        permit: &BrowserActionPermit,
        cdp: BrowserCdp,
        target: &BrowserElementTarget,
        ids: &[BrowserUploadId],
    ) -> Result<NativeBrowserResponse, BrowserRuntimeError> {
        let page = self
            .resource
            .host
            .lock()
            .await
            .dispatch_target(permit)?
            .clone();
        let (paths, manifests) = self.resource.uploads.lock().await.sealed(ids)?;
        let mut element = target.resolve(cdp, page.as_str()).await?;
        self.validate_find(engine, permit, &mut element).await?;
        let input = element.call("function(){return {file:this.isConnected&&this instanceof HTMLInputElement&&this.type==='file'&&!this.matches(':disabled')&&this.getAttribute('aria-disabled')!=='true',multiple:this.multiple};}").await?;
        if input["file"] != true {
            return Err("browser_upload_input_required".into());
        }
        if paths.len() > 1 && input["multiple"] != true {
            return Err("browser_upload_multiple_required".into());
        }
        let result: Result<_, BrowserRuntimeError> = async {
            element.set_files(&paths).await?;
            Ok(NativeBrowserResponse {
                id: "browser-upload".into(),
                success: true,
                data: json!({"files":manifests}),
                error: None,
            })
        }
        .await;
        finish_element_result(result)
    }
}
