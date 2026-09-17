use std::{
    cmp::Reverse,
    collections::BinaryHeap,
    fs,
    path::{Path, PathBuf},
    time::SystemTime,
};

// Enumerating metadata is independent of the much smaller transcript-read
// budget. Keep only the newest paths in memory; never open rollout contents here.
const MAX_DISCOVERY_ENTRIES: usize = 131_072;
const MAX_DEPTH: usize = 4;

type RecentFiles = BinaryHeap<Reverse<(SystemTime, PathBuf)>>;

fn visit(
    directory: &Path,
    depth: usize,
    inspected: &mut usize,
    limit: usize,
    files: &mut RecentFiles,
) {
    if depth > MAX_DEPTH || *inspected >= MAX_DISCOVERY_ENTRIES {
        return;
    }
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        if *inspected >= MAX_DISCOVERY_ENTRIES {
            return;
        }
        *inspected += 1;
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            visit(&entry.path(), depth + 1, inspected, limit, files);
        } else if kind.is_file()
            && entry.path().extension().and_then(|value| value.to_str()) == Some("jsonl")
        {
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            files.push(Reverse((modified, entry.path())));
            if files.len() > limit {
                files.pop();
            }
        }
    }
}

/// Select by last activity across all date directories before applying the
/// transcript limit. Calendar paths encode creation, so resuming an older
/// conversation must still move it into the recent history.
pub(super) fn recent(root: &Path, limit: usize) -> Vec<PathBuf> {
    if limit == 0 {
        return Vec::new();
    }
    let mut files = RecentFiles::new();
    visit(root, 0, &mut 0, limit, &mut files);
    files
        .into_sorted_vec()
        .into_iter()
        .map(|Reverse((_, path))| path)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::atomic::{AtomicUsize, Ordering},
        time::{Duration, SystemTime},
    };

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let path = std::env::temp_dir().join(format!(
                "dure-codex-recency-{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT.fetch_add(1, Ordering::Relaxed),
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn rollout(&self, relative: &str, updated: u64) -> PathBuf {
            let path = self.0.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let file = fs::File::create(&path).unwrap();
            file.set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(updated))
                .unwrap();
            path
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn newest_app_rollout_survives_a_full_older_history() {
        let fixture = Fixture::new();
        for index in 0..300 {
            fixture.rollout(&format!("2026/07/01/old-{index:03}.jsonl"), 100);
        }
        let latest = fixture.rollout("2026/09/15/app.jsonl", 300);
        let files = recent(&fixture.0, 200);
        assert_eq!(files.first(), Some(&latest));
        assert_eq!(files.len(), 200);
    }

    #[test]
    fn an_old_rollout_resumed_today_precedes_newer_calendar_paths() {
        let fixture = Fixture::new();
        let resumed = fixture.rollout("2026/04/01/resumed.jsonl", 500);
        fixture.rollout("2026/09/15/app.jsonl", 300);
        assert_eq!(recent(&fixture.0, 1), vec![resumed]);
    }

    #[test]
    fn a_busy_day_does_not_hide_files_beyond_the_directory_entry_cap() {
        let fixture = Fixture::new();
        for index in 0..300 {
            fixture.rollout(&format!("2026/09/15/rollout-{index:03}.jsonl"), 100);
        }
        let latest = fixture.rollout("2026/09/15/rollout-999.jsonl", 500);
        let files = recent(&fixture.0.join("2026/09/15"), 200);
        assert_eq!(files.first(), Some(&latest));
        assert_eq!(files.len(), 200);
    }

    #[test]
    fn empty_missing_and_zero_limit_histories_are_empty() {
        let fixture = Fixture::new();
        assert!(recent(&fixture.0, 200).is_empty());
        assert!(recent(&fixture.0.join("missing"), 200).is_empty());
        fixture.rollout("entry.jsonl", 100);
        assert!(recent(&fixture.0, 0).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn ignores_symlinked_files_directories_and_other_extensions() {
        let fixture = Fixture::new();
        let outside = Fixture::new();
        let target = outside.rollout("private.jsonl", 900);
        std::os::unix::fs::symlink(target, fixture.0.join("link.jsonl")).unwrap();
        std::os::unix::fs::symlink(&outside.0, fixture.0.join("linked-directory")).unwrap();
        fixture.rollout("state.sqlite", 800);
        let actual = fixture.rollout("own.jsonl", 100);
        assert_eq!(recent(&fixture.0, 200), vec![actual]);
    }
}
