use crate::gitx::{run_git, scrub_git_environment};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Only a private snapshot admits intent-to-add. Advisory tracked-only reads
/// borrow the real index without optional writes; reviews always take a copy.
pub(super) enum DiffIndex {
    Worktree,
    Snapshot(tempfile::TempPath),
}

impl DiffIndex {
    pub(super) fn observe(worktree: &str) -> Result<Self, String> {
        let untracked = run_git(
            worktree,
            &[
                "--no-optional-locks",
                "ls-files",
                "--others",
                "--exclude-standard",
                "--directory",
                "--no-empty-directory",
                "-z",
            ],
        )?;
        if untracked.is_empty() {
            Ok(Self::Worktree)
        } else {
            Self::create(worktree)
        }
    }

    pub(super) fn create(worktree: &str) -> Result<Self, String> {
        let real = run_git(worktree, &["rev-parse", "--git-path", "index"])?;
        let real = real.trim();
        let real_path = if Path::new(real).is_absolute() {
            PathBuf::from(real)
        } else {
            Path::new(worktree).join(real)
        };
        let temporary = tempfile::Builder::new()
            .prefix("dure-diff-index-")
            .tempfile()
            .map_err(|error| format!("temporary index: {error}"))?
            .into_temp_path();
        if real_path.exists() {
            let copied = std::fs::copy(&real_path, &temporary)
                .map_err(|error| format!("index copy: {error}"))?;
            #[cfg(test)]
            super::observation_tests::record_index_copy(copied);
            let _ = copied;
        } else {
            // Git accepts a missing index, but not the empty tempfile header.
            std::fs::remove_file(&temporary).map_err(|error| format!("empty index: {error}"))?;
        }
        let index = Self::Snapshot(temporary);
        index.git(
            worktree,
            &["add", "--intent-to-add", "--ignore-errors", "--", "."],
        )?;
        Ok(index)
    }

    pub(super) fn git(&self, worktree: &str, args: &[&str]) -> Result<String, String> {
        let mut command = Command::new("git");
        command
            .arg("--no-optional-locks")
            .arg("-C")
            .arg(worktree)
            // diff's stat-only refresh does not honor optional-lock suppression.
            .args(["-c", "diff.autoRefreshIndex=false"])
            // Keep patch headers aligned with raw, NUL-delimited paths.
            .args([
                "-c",
                "diff.noprefix=false",
                "-c",
                "diff.mnemonicprefix=false",
                "-c",
                "core.quotepath=false",
            ])
            .args(args);
        scrub_git_environment(&mut command);
        if let Self::Snapshot(path) = self {
            command.env("GIT_INDEX_FILE", path);
        }
        let output = command.output().map_err(|error| format!("git: {error}"))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).into_owned());
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }
}
