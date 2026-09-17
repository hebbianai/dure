//! Preserve the existing 60-second PreToolUse report coalescing. A stamp is
//! only a transport optimization after successful delivery, never readiness.

use std::{
    fs::{DirBuilder, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::Duration,
};

use reqwest::header::HeaderMap;
use sha2::{Digest, Sha256};

pub(super) struct Stamp {
    path: PathBuf,
    fence: Vec<u8>,
}

impl Stamp {
    pub fn new(root: &Path, conversation: &str, headers: &HeaderMap) -> Self {
        let identity = Sha256::digest(conversation.as_bytes());
        let mut fence = Sha256::new();
        for (header, _) in super::FENCE_HEADERS {
            fence.update(headers[header].as_bytes());
            fence.update([0]);
        }
        Self {
            path: root
                .join("hook-throttle")
                .join(format!("pretooluse-{identity:x}.stamp")),
            fence: format!("{:x}", fence.finalize()).into_bytes(),
        }
    }

    pub fn recent(&self) -> bool {
        let Some(directory) = self.path.parent() else {
            return false;
        };
        if !super::descriptor::owned_directory(directory) {
            return false;
        }
        let Ok(mut file) = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
            .open(&self.path)
        else {
            return false;
        };
        let Ok(metadata) = file.metadata() else {
            return false;
        };
        // SAFETY: geteuid takes no arguments and returns this process's UID.
        if !metadata.is_file()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o077 != 0
            || metadata.len() != self.fence.len() as u64
            || !metadata
                .modified()
                .ok()
                .and_then(|time| time.elapsed().ok())
                .is_some_and(|elapsed| elapsed < Duration::from_secs(60))
        {
            return false;
        }
        let mut contents = Vec::new();
        (&mut file).take(65).read_to_end(&mut contents).is_ok() && contents == self.fence
    }

    pub fn record(&self) {
        let Some(directory) = self.path.parent() else {
            return;
        };
        let _ = DirBuilder::new().mode(0o700).create(directory);
        if !super::descriptor::owned_directory(directory) {
            return;
        }
        // Replacing our own private stamp atomically avoids following a link or
        // truncating another file if the previous entry has been substituted.
        let result = (|| -> std::io::Result<()> {
            let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
            temporary.write_all(&self.fence)?;
            temporary
                .persist(&self.path)
                .map_err(std::io::Error::other)?;
            Ok(())
        })();
        let _ = result;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn only_successful_same_generation_reports_coalesce() {
        let root = tempfile::tempdir().unwrap();
        let mut headers = super::super::fence_headers(&super::super::tests::environment()).unwrap();
        let stamp = Stamp::new(root.path(), "../conversation", &headers);
        assert!(!stamp.recent());
        stamp.record();
        assert!(stamp.recent());
        headers.insert(
            "x-hebbian-hmux-terminal-epoch",
            "next-generation".parse().unwrap(),
        );
        let changed = Stamp::new(root.path(), "../conversation", &headers);
        assert!(!changed.recent());
        changed.record();
        assert!(changed.recent());
        assert!(!stamp.recent());
        assert_eq!(
            fs::read_dir(root.path().join("hook-throttle"))
                .unwrap()
                .count(),
            1
        );
    }
}
