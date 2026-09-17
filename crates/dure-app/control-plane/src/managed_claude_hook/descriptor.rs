use std::{
    fs::{self, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::Instant,
};

use serde::Deserialize;

const MAX_DESCRIPTOR_BYTES: u64 = 16 * 1024;
const MAX_CANDIDATES: usize = 32;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Descriptor {
    pub port: u16,
    pub process_id: u32,
    pub channel: String,
    pub generation: String,
    pub report_token: String,
}

pub(super) struct AppRoot {
    pub path: PathBuf,
    pub writable: bool,
}

pub(super) fn app_root() -> Option<AppRoot> {
    if let Some(root) = std::env::var_os("DURE_HOME").filter(|root| !root.is_empty()) {
        let root = PathBuf::from(root);
        return root.is_absolute().then_some(AppRoot {
            path: root,
            writable: true,
        });
    }
    let home = PathBuf::from(std::env::var_os("HOME")?);
    if !home.is_absolute() {
        return None;
    }
    let canonical = home.join(".dure");
    if canonical.is_dir() {
        return Some(AppRoot {
            path: canonical,
            writable: true,
        });
    }
    let legacy = home.join(".hebbian");
    Some(if legacy.is_dir() {
        AppRoot {
            path: legacy,
            writable: false,
        }
    } else {
        AppRoot {
            path: canonical,
            writable: true,
        }
    })
}

pub(super) fn owned_directory(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| {
        // SAFETY: geteuid takes no arguments and returns this process's UID.
        metadata.is_dir()
            && metadata.uid() == unsafe { libc::geteuid() }
            && metadata.mode() & 0o077 == 0
    })
}

fn valid_channel(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

pub(super) fn candidates(root: &Path, deadline: Instant) -> Vec<PathBuf> {
    let mut candidates = Vec::with_capacity(MAX_CANDIDATES + 1);
    let mut consider = |path: PathBuf| {
        if let Ok(modified) = fs::symlink_metadata(&path).and_then(|metadata| metadata.modified()) {
            candidates.push((modified, path));
            candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.0));
            candidates.truncate(MAX_CANDIDATES);
        }
    };
    consider(root.join("server.json"));
    let channels = root.join("channels");
    if owned_directory(&channels) {
        if let Ok(entries) = fs::read_dir(&channels) {
            for entry in entries.flatten() {
                if Instant::now() >= deadline {
                    break;
                }
                if entry.file_name().to_str().is_some_and(valid_channel)
                    && owned_directory(&entry.path())
                {
                    consider(entry.path().join("server.json"));
                }
            }
        }
    }
    candidates.into_iter().map(|(_, path)| path).collect()
}

pub(super) fn read(root: &Path, path: &Path) -> Option<Descriptor> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)
        .ok()?;
    let metadata = file.metadata().ok()?;
    // SAFETY: geteuid takes no arguments and returns this process's UID.
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
        || metadata.len() > MAX_DESCRIPTOR_BYTES
    {
        return None;
    }
    let mut raw = Vec::new();
    (&mut file)
        .take(MAX_DESCRIPTOR_BYTES + 1)
        .read_to_end(&mut raw)
        .ok()?;
    if raw.len() > MAX_DESCRIPTOR_BYTES as usize {
        return None;
    }
    let descriptor: Descriptor = serde_json::from_slice(&raw).ok()?;
    let expected_channel = if path == root.join("server.json") {
        "stable"
    } else {
        let parent = path.parent()?;
        if parent.parent()? != root.join("channels") || path.file_name()? != "server.json" {
            return None;
        }
        parent.file_name()?.to_str()?
    };
    if descriptor.channel != expected_channel
        || !valid_channel(&descriptor.channel)
        || descriptor.port == 0
        || descriptor.process_id == 0
        || !super::identifier(&descriptor.generation)
        || descriptor.report_token.is_empty()
        || descriptor.report_token.len() > 256
        || descriptor.report_token.contains(['\r', '\n'])
    {
        return None;
    }
    Some(descriptor)
}
