//! Process-wide parsed usage cache with a single background persistence worker.
//!
//! `usage_recent` is polled by more than one UI surface. Loading and rewriting a
//! multi-megabyte JSON cache on every poll replaced the old raw-log storm with a
//! smaller periodic CPU spike. This runtime loads once per canonical home,
//! mutates under one lock, and queues only changed entries to one background
//! writer. Cache persistence is an optimization: a failed flush may make the
//! next process start slower, but never changes the reported usage.

use std::{
    collections::HashMap,
    sync::{mpsc, Arc, Mutex, OnceLock},
    thread,
};

use crate::usage_cache::{UsageCacheWrite, UsageScanCache};

#[derive(Default)]
struct CacheSlot {
    cache: UsageScanCache,
    flush_queued: bool,
    pending: Option<UsageCacheWrite>,
}

struct CacheRuntime {
    slots: Arc<Mutex<HashMap<String, CacheSlot>>>,
    flush_tx: mpsc::Sender<String>,
}

fn runtime() -> &'static CacheRuntime {
    static RUNTIME: OnceLock<CacheRuntime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        let slots = Arc::new(Mutex::new(HashMap::new()));
        let (flush_tx, flush_rx) = mpsc::channel();
        let worker_slots = Arc::clone(&slots);
        thread::Builder::new()
            .name("dure-usage-cache-flush".into())
            .spawn(move || flush_loop(worker_slots, flush_rx))
            .expect("usage cache flush worker should start");
        CacheRuntime { slots, flush_tx }
    })
}

/// Run one cache transaction. The cache is loaded from disk only for the first
/// request for a home in this process. A dirty transaction schedules one
/// coalesced background flush; unchanged warm reads perform no disk write and
/// changed reads append only the affected cache entries.
pub fn with_cache<T>(home: &str, operation: impl FnOnce(&mut UsageScanCache) -> T) -> T {
    let runtime = runtime();
    let mut slots = runtime
        .slots
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let slot = slots.entry(home.to_string()).or_insert_with(|| CacheSlot {
        cache: UsageScanCache::load(home),
        ..Default::default()
    });
    let result = operation(&mut slot.cache);
    if let Some(write) = slot.cache.take_write() {
        slot.pending = Some(match slot.pending.take() {
            Some(pending) => pending.merge(write),
            None => write,
        });
    }
    let queue_flush = slot.pending.is_some() && !slot.flush_queued;
    if queue_flush {
        slot.flush_queued = true;
    }
    drop(slots);

    if queue_flush && runtime.flush_tx.send(home.to_string()).is_err() {
        let mut slots = runtime
            .slots
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(slot) = slots.get_mut(home) {
            slot.flush_queued = false;
        }
    }
    result
}

fn flush_loop(slots: Arc<Mutex<HashMap<String, CacheSlot>>>, flush_rx: mpsc::Receiver<String>) {
    while let Ok(home) = flush_rx.recv() {
        loop {
            let mut locked = slots.lock().unwrap_or_else(|error| error.into_inner());
            let Some(slot) = locked.get_mut(&home) else { break };
            let Some(mut write) = slot.pending.take() else {
                slot.flush_queued = false;
                break;
            };
            drop(locked);

            // Filesystem serialization and JSON streaming never hold the process
            // cache mutex. The write itself owns the cross-process file lock.
            let written = write.write(&home);
            let compacted = !written
                || !crate::usage_cache::journal_needs_compaction(&home)
                || crate::usage_cache::compact_persisted_cache(&home);
            let mut locked = slots.lock().unwrap_or_else(|error| error.into_inner());
            let Some(slot) = locked.get_mut(&home) else {
                break;
            };
            if !written {
                slot.pending = Some(match slot.pending.take() {
                    Some(newer) => write.merge(newer),
                    None => write,
                });
                slot.flush_queued = false;
                break;
            }
            if !compacted {
                slot.cache.retry_with_compaction();
                if let Some(compaction) = slot.cache.take_write() {
                    slot.pending = Some(match slot.pending.take() {
                        Some(pending) => compaction.merge(pending),
                        None => compaction,
                    });
                }
            }
            if slot.pending.is_none() {
                slot.flush_queued = false;
                break;
            }
            // A scan changed the cache while this generation was being written.
            // Keep ownership of the one queued flush and append the coalesced
            // replacement instead of enqueueing a parallel writer.
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage_cache::{ClaudeRecord, FileStamp, Resume};
    use std::{fs, path::PathBuf, time::Duration};

    fn tmpdir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dure-usage-cache-runtime-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn unchanged_warm_transaction_does_not_rewrite_the_cache() {
        let home = tmpdir("dirty-only");
        let log = home.join("a.jsonl");
        fs::write(&log, "x\n").unwrap();
        with_cache(home.to_str().unwrap(), |cache| {
            cache.put_claude(
                &log,
                FileStamp::of(&log).unwrap(),
                Resume::default(),
                Vec::new(),
            );
        });
        let path = crate::usage_cache::cache_path(home.to_str().unwrap());
        for _ in 0..100 {
            if fs::metadata(&path).is_ok_and(|metadata| metadata.len() > 0) {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        let first = fs::metadata(&path).unwrap().modified().unwrap();
        thread::sleep(Duration::from_millis(20));

        with_cache(home.to_str().unwrap(), |_| {});
        thread::sleep(Duration::from_millis(50));

        assert_eq!(fs::metadata(path).unwrap().modified().unwrap(), first);
    }

    #[test]
    fn changed_warm_transaction_appends_a_replacement_without_rewriting_the_snapshot() {
        let home = tmpdir("replacement-only");
        let log = home.join("a.jsonl");
        fs::write(&log, "x\n").unwrap();
        with_cache(home.to_str().unwrap(), |cache| {
            cache.put_claude(
                &log,
                FileStamp::of(&log).unwrap(),
                Resume::default(),
                vec![ClaudeRecord { input: 1, ..Default::default() }],
            );
        });
        let snapshot_path = crate::usage_cache::cache_path(home.to_str().unwrap());
        for _ in 0..100 {
            if fs::metadata(&snapshot_path).is_ok_and(|metadata| metadata.len() > 0) {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        let snapshot = fs::read(&snapshot_path).unwrap();

        with_cache(home.to_str().unwrap(), |cache| {
            cache.put_claude(
                &log,
                FileStamp::of(&log).unwrap(),
                Resume::default(),
                vec![ClaudeRecord { input: 9, ..Default::default() }],
            );
        });
        let journal_path = crate::usage_cache::cache_journal_path(home.to_str().unwrap());
        for _ in 0..100 {
            if fs::metadata(&journal_path).is_ok_and(|metadata| metadata.len() > 0) {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }

        assert_eq!(fs::read(snapshot_path).unwrap(), snapshot);
        assert!(fs::metadata(journal_path).unwrap().len() < 1024);
    }
}
