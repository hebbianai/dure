use std::fs::{self, File, OpenOptions};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::recipe::CapturedRecipe;
use crate::private_record;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum Status {
    Creating,
    Running,
    Suspending,
    Suspended,
    Resuming,
    Destroying,
    Failed,
    CleanupFailed,
    Destroyed,
}

impl Status {
    pub fn pending(&self) -> bool {
        matches!(
            self,
            Self::Creating | Self::Suspending | Self::Resuming | Self::Destroying
        )
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Connection {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub key_path: Option<String>,
    pub project_root: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RecipeResult {
    pub schema_version: u16,
    pub resource_id: String,
    pub connection: Connection,
    #[serde(default)]
    pub user_data: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Record {
    pub schema_version: u16,
    pub id: String,
    pub revision: u64,
    pub project_path: PathBuf,
    pub name: String,
    pub recipe: CapturedRecipe,
    pub request_key: String,
    pub last_action_key: String,
    pub last_action: String,
    pub generation: String,
    pub status: Status,
    pub result: Option<RecipeResult>,
    pub error: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Clone)]
pub(super) struct Store(pub PathBuf);

impl Store {
    pub fn open(root: &Path) -> Result<Self, &'static str> {
        let path = root.join("workspace-environments");
        Self::private_directory(&path)?;
        Ok(Self(
            fs::canonicalize(path).map_err(|_| "environment_store_unavailable")?,
        ))
    }

    pub fn workdir(&self, id: &str) -> Result<PathBuf, &'static str> {
        let path = self.0.join(id);
        Self::private_directory(&path)?;
        Ok(path)
    }

    fn private_directory(path: &Path) -> Result<(), &'static str> {
        match fs::DirBuilder::new().mode(0o700).create(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err("environment_store_unavailable"),
        }
        let metadata = fs::symlink_metadata(path).map_err(|_| "environment_store_unavailable")?;
        if !metadata.is_dir()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o077 != 0
        {
            return Err("environment_store_invalid");
        }
        Ok(())
    }

    // The directory lock also travels into the bounded provider child. A backend
    // crash must not let its successor destroy resources while create still runs.
    pub fn lock(&self, id: &str) -> Result<File, &'static str> {
        let path = self.workdir(id)?;
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)
            .map_err(|_| "environment_store_unavailable")?;
        let metadata = file
            .metadata()
            .map_err(|_| "environment_store_unavailable")?;
        if !metadata.is_dir()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o077 != 0
        {
            return Err("environment_store_invalid");
        }
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err("environment_busy");
        }
        Ok(file)
    }

    pub fn read(&self, id: &str) -> Result<Option<Record>, &'static str> {
        private_record::read_bounded(&self.path(id), 384 * 1024)
            .map_err(|_| "environment_store_unavailable")?
            .map(|bytes| {
                let record: Record =
                    serde_json::from_slice(&bytes).map_err(|_| "environment_store_invalid")?;
                if record.id != id || record.schema_version != 1 || record.revision == 0 {
                    return Err("environment_store_invalid");
                }
                Ok(record)
            })
            .transpose()
    }

    pub fn write(&self, record: &Record) -> Result<(), &'static str> {
        private_record::write(&self.path(&record.id), record)
            .map_err(|_| "environment_store_unavailable")
    }

    pub fn list(&self) -> Result<Vec<Record>, &'static str> {
        let mut records = Vec::new();
        for entry in fs::read_dir(&self.0).map_err(|_| "environment_store_unavailable")? {
            let entry = entry.map_err(|_| "environment_store_unavailable")?;
            let name = entry.file_name();
            let Some(id) = name.to_str().and_then(|name| name.strip_suffix(".json")) else {
                continue;
            };
            if !valid_id(id) {
                return Err("environment_store_invalid");
            }
            if let Some(record) = self.read(id)? {
                records.push(record);
            }
            if records.len() > 512 {
                return Err("environment_store_full");
            }
        }
        records.sort_by(|a, b| b.created_at_ms.cmp(&a.created_at_ms).then(a.id.cmp(&b.id)));
        Ok(records)
    }

    fn path(&self, id: &str) -> PathBuf {
        self.0.join(format!("{id}.json"))
    }
}

pub(super) fn valid_id(id: &str) -> bool {
    id.strip_prefix("env-").is_some_and(|suffix| {
        suffix.len() == 64 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}
