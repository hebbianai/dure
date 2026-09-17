use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex, TryLockError,
};
use std::time::{Duration, Instant};

use crate::usage::UsageRecentSnapshot;

#[derive(serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UsageRefreshProvider {
    Claude,
    Codex,
}

#[derive(Clone, Default)]
pub struct UsageRecentRuntime {
    inner: Arc<RuntimeInner>,
}

#[derive(Default)]
struct RuntimeInner {
    state: Mutex<RuntimeState>,
    coalesced_requests: AtomicU64,
    snapshot_cache_hits: AtomicU64,
}

#[derive(Default)]
struct RuntimeState {
    completed: Option<UsageRecentSnapshot>,
    completed_at: Option<Instant>,
}

impl UsageRecentRuntime {
    pub fn snapshot(&self) -> UsageRecentSnapshot {
        self.snapshot_with_freshness(Duration::from_secs(30), crate::usage::usage_recent_snapshot)
    }

    pub fn refresh(&self) -> UsageRecentSnapshot {
        self.snapshot_with_freshness(Duration::ZERO, crate::usage::usage_recent_snapshot)
    }

    #[cfg(test)]
    fn snapshot_with<F>(&self, scan: F) -> UsageRecentSnapshot
    where
        F: FnOnce() -> UsageRecentSnapshot,
    {
        self.snapshot_with_freshness(Duration::ZERO, scan)
    }

    fn snapshot_with_freshness<F>(&self, fresh_for: Duration, scan: F) -> UsageRecentSnapshot
    where
        F: FnOnce() -> UsageRecentSnapshot,
    {
        match self.inner.state.try_lock() {
            Ok(mut state) => self.run_scan(&mut state, fresh_for, scan),
            Err(TryLockError::WouldBlock) => {
                self.inner
                    .coalesced_requests
                    .fetch_add(1, Ordering::Relaxed);
                let state = self
                    .inner
                    .state
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                let Some(mut snapshot) = state.completed.clone() else {
                    drop(state);
                    return self.snapshot_with_freshness(fresh_for, scan);
                };
                self.apply_runtime_telemetry(&mut snapshot);
                snapshot
            }
            Err(TryLockError::Poisoned(error)) => {
                let mut state = error.into_inner();
                self.run_scan(&mut state, fresh_for, scan)
            }
        }
    }

    fn run_scan<F>(
        &self,
        state: &mut RuntimeState,
        fresh_for: Duration,
        scan: F,
    ) -> UsageRecentSnapshot
    where
        F: FnOnce() -> UsageRecentSnapshot,
    {
        if state
            .completed_at
            .is_some_and(|completed_at| completed_at.elapsed() < fresh_for)
        {
            self.inner
                .snapshot_cache_hits
                .fetch_add(1, Ordering::Relaxed);
            let mut snapshot = state.completed.clone().unwrap_or_default();
            self.apply_runtime_telemetry(&mut snapshot);
            return snapshot;
        }
        let mut snapshot = scan();
        self.apply_runtime_telemetry(&mut snapshot);
        state.completed = Some(snapshot.clone());
        state.completed_at = Some(Instant::now());
        snapshot
    }

    fn apply_runtime_telemetry(&self, snapshot: &mut UsageRecentSnapshot) {
        snapshot.telemetry.coalesced_requests =
            self.inner.coalesced_requests.load(Ordering::Relaxed);
        snapshot.telemetry.snapshot_cache_hits =
            self.inner.snapshot_cache_hits.load(Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{atomic::AtomicUsize, Barrier},
        thread,
        time::Duration,
    };

    #[test]
    fn overlapping_requests_share_one_scan() {
        let runtime = UsageRecentRuntime::default();
        let scans = Arc::new(AtomicUsize::new(0));
        let start = Arc::new(Barrier::new(9));
        let workers = (0..8)
            .map(|_| {
                let runtime = runtime.clone();
                let scans = Arc::clone(&scans);
                let start = Arc::clone(&start);
                thread::spawn(move || {
                    start.wait();
                    runtime.snapshot_with(|| {
                        scans.fetch_add(1, Ordering::SeqCst);
                        thread::sleep(Duration::from_millis(100));
                        UsageRecentSnapshot::default()
                    })
                })
            })
            .collect::<Vec<_>>();
        start.wait();
        let snapshots = workers
            .into_iter()
            .map(|worker| worker.join().expect("usage worker should not panic"))
            .collect::<Vec<_>>();

        assert_eq!(scans.load(Ordering::SeqCst), 1);
        assert!(snapshots.iter().all(|snapshot| {
            snapshot.telemetry.coalesced_requests == 7 || snapshot.telemetry.coalesced_requests == 0
        }));
        assert_eq!(runtime.inner.coalesced_requests.load(Ordering::SeqCst), 7);
    }

    #[test]
    fn sequential_clients_reuse_a_fresh_backend_snapshot() {
        let runtime = UsageRecentRuntime::default();
        let scans = AtomicUsize::new(0);

        let _ = runtime.snapshot_with_freshness(Duration::from_secs(30), || {
            scans.fetch_add(1, Ordering::SeqCst);
            UsageRecentSnapshot::default()
        });
        let reused = runtime.snapshot_with_freshness(Duration::from_secs(30), || {
            scans.fetch_add(1, Ordering::SeqCst);
            UsageRecentSnapshot::default()
        });

        assert_eq!(scans.load(Ordering::SeqCst), 1);
        assert_eq!(reused.telemetry.snapshot_cache_hits, 1);
    }

    #[test]
    fn manual_refresh_replaces_a_fresh_snapshot_for_subsequent_readers() {
        let runtime = UsageRecentRuntime::default();
        let _ = runtime.snapshot_with_freshness(Duration::from_secs(30), || {
            let mut snapshot = UsageRecentSnapshot::default();
            snapshot.five_hours.claude.used_percent = Some(10.0);
            snapshot
        });
        let refreshed = runtime.snapshot_with(|| {
            let mut snapshot = UsageRecentSnapshot::default();
            snapshot.five_hours.claude.used_percent = Some(25.0);
            snapshot
        });
        assert_eq!(refreshed.five_hours.claude.used_percent, Some(25.0));
        let cached = runtime.snapshot_with_freshness(Duration::from_secs(30), || {
            panic!("the refreshed snapshot should remain cached")
        });
        assert_eq!(cached.five_hours.claude.used_percent, Some(25.0));
    }
}
