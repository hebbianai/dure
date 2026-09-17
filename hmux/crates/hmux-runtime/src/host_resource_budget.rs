#[cfg(unix)]
use std::sync::Condvar;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
#[cfg(unix)]
use std::time::Duration;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ConnectionClass {
    Ordinary,
    Priority,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ConnectionRejection {
    PendingLimit,
    ActiveLimit,
}

impl ConnectionRejection {
    pub(crate) const fn diagnostic_code(self) -> &'static str {
        match self {
            Self::PendingLimit => "pending_connection_limit",
            Self::ActiveLimit => "active_connection_limit",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct HostResourceLimits {
    pub(crate) max_pending_connections: usize,
    pub(crate) max_active_connections: usize,
    pub(crate) reserved_priority_connections: usize,
    pub(crate) max_queued_bytes: usize,
}

impl HostResourceLimits {
    pub(crate) fn validate(self) -> Self {
        assert!(self.max_pending_connections > 0);
        assert!(self.max_active_connections > 0);
        assert!(self.reserved_priority_connections < self.max_active_connections);
        assert!(self.max_queued_bytes > 0);
        self
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct HostResourceSnapshot {
    pub(crate) connection_workers: usize,
    pub(crate) peak_connection_workers: usize,
    pub(crate) pending_connections: usize,
    pub(crate) active_connections: usize,
    pub(crate) peak_pending_connections: usize,
    pub(crate) peak_active_connections: usize,
    pub(crate) rejected_pending_connections: usize,
    pub(crate) rejected_active_connections: usize,
    pub(crate) queued_bytes: usize,
    pub(crate) peak_queued_bytes: usize,
    pub(crate) rejected_queue_pushes: usize,
}

#[derive(Default)]
struct ConnectionState {
    workers: usize,
    peak_workers: usize,
    pending: usize,
    active: usize,
    active_ordinary: usize,
    peak_pending: usize,
    peak_active: usize,
    rejected_pending: usize,
    rejected_active: usize,
}

pub(crate) struct HostResourceBudget {
    limits: HostResourceLimits,
    connections: Mutex<ConnectionState>,
    #[cfg(unix)]
    workers_changed: Condvar,
    queued_bytes: AtomicUsize,
    peak_queued_bytes: AtomicUsize,
    rejected_queue_pushes: AtomicUsize,
}

impl HostResourceBudget {
    pub(crate) fn new(limits: HostResourceLimits) -> Arc<Self> {
        Arc::new(Self {
            limits: limits.validate(),
            connections: Mutex::new(ConnectionState::default()),
            #[cfg(unix)]
            workers_changed: Condvar::new(),
            queued_bytes: AtomicUsize::new(0),
            peak_queued_bytes: AtomicUsize::new(0),
            rejected_queue_pushes: AtomicUsize::new(0),
        })
    }

    pub(crate) fn try_acquire_pending(
        self: &Arc<Self>,
    ) -> Result<ConnectionPermit, ConnectionRejection> {
        let mut state = self.connection_state();
        if state.pending >= self.limits.max_pending_connections {
            state.rejected_pending = state.rejected_pending.saturating_add(1);
            return Err(ConnectionRejection::PendingLimit);
        }
        state.pending += 1;
        state.peak_pending = state.peak_pending.max(state.pending);
        drop(state);
        Ok(ConnectionPermit {
            budget: Arc::clone(self),
            phase: PermitPhase::Pending,
        })
    }

    fn promote(&self, class: ConnectionClass) -> Result<(), ConnectionRejection> {
        let mut state = self.connection_state();
        let ordinary_limit = self
            .limits
            .max_active_connections
            .saturating_sub(self.limits.reserved_priority_connections);
        let saturated = state.active >= self.limits.max_active_connections
            || (class == ConnectionClass::Ordinary && state.active_ordinary >= ordinary_limit);
        if saturated {
            state.rejected_active = state.rejected_active.saturating_add(1);
            return Err(ConnectionRejection::ActiveLimit);
        }
        state.pending = state.pending.saturating_sub(1);
        state.active += 1;
        if class == ConnectionClass::Ordinary {
            state.active_ordinary += 1;
        }
        state.peak_active = state.peak_active.max(state.active);
        Ok(())
    }

    fn release_pending(&self) {
        let mut state = self.connection_state();
        state.pending = state.pending.saturating_sub(1);
    }

    fn release_active(&self, class: ConnectionClass) {
        let mut state = self.connection_state();
        state.active = state.active.saturating_sub(1);
        if class == ConnectionClass::Ordinary {
            state.active_ordinary = state.active_ordinary.saturating_sub(1);
        }
    }

    pub(crate) fn try_reserve_queue_bytes(
        self: &Arc<Self>,
        accounted_bytes: usize,
    ) -> Option<QueueReservation> {
        let reserved =
            self.queued_bytes
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                    current
                        .checked_add(accounted_bytes)
                        .filter(|next| *next <= self.limits.max_queued_bytes)
                });
        let previous = match reserved {
            Ok(previous) => previous,
            Err(_) => {
                self.rejected_queue_pushes.fetch_add(1, Ordering::Relaxed);
                return None;
            }
        };
        let current = previous + accounted_bytes;
        self.peak_queued_bytes.fetch_max(current, Ordering::Relaxed);
        Some(QueueReservation {
            accounted_bytes,
            budget: Arc::clone(self),
        })
    }

    pub(crate) fn snapshot(&self) -> HostResourceSnapshot {
        let state = self.connection_state();
        HostResourceSnapshot {
            connection_workers: state.workers,
            peak_connection_workers: state.peak_workers,
            pending_connections: state.pending,
            active_connections: state.active,
            peak_pending_connections: state.peak_pending,
            peak_active_connections: state.peak_active,
            rejected_pending_connections: state.rejected_pending,
            rejected_active_connections: state.rejected_active,
            queued_bytes: self.queued_bytes.load(Ordering::Acquire),
            peak_queued_bytes: self.peak_queued_bytes.load(Ordering::Acquire),
            rejected_queue_pushes: self.rejected_queue_pushes.load(Ordering::Acquire),
        }
    }

    pub(crate) fn record_queue_rejection(&self) {
        self.rejected_queue_pushes.fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn connection_worker_started(self: &Arc<Self>) -> ConnectionWorkerGuard {
        let mut state = self.connection_state();
        state.workers += 1;
        state.peak_workers = state.peak_workers.max(state.workers);
        drop(state);
        ConnectionWorkerGuard {
            budget: Arc::clone(self),
        }
    }

    fn connection_state(&self) -> std::sync::MutexGuard<'_, ConnectionState> {
        self.connections
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// After the accept loop joins, wait for the existing worker lifetimes,
    /// including outbound drain. No new worker can arrive after that barrier.
    #[cfg(unix)]
    pub(crate) fn wait_for_connection_workers(&self, timeout: Duration) -> bool {
        let (state, _) = self
            .workers_changed
            .wait_timeout_while(self.connection_state(), timeout, |state| state.workers != 0)
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.workers == 0
    }
}

pub(crate) struct ConnectionWorkerGuard {
    budget: Arc<HostResourceBudget>,
}

impl Drop for ConnectionWorkerGuard {
    fn drop(&mut self) {
        let mut state = self.budget.connection_state();
        state.workers = state.workers.saturating_sub(1);
        drop(state);
        #[cfg(unix)]
        self.budget.workers_changed.notify_all();
    }
}

enum PermitPhase {
    Pending,
    Active(Arc<ActiveConnectionLease>),
    Released,
}

struct ActiveConnectionLease {
    budget: Arc<HostResourceBudget>,
    class: ConnectionClass,
}

impl Drop for ActiveConnectionLease {
    fn drop(&mut self) {
        self.budget.release_active(self.class);
    }
}

/// Keeps one promoted connection inside the Host-wide active ceiling after
/// its socket has detached while attachment-owned work is still running.
#[cfg(feature = "terminal-state-stream")]
#[derive(Clone)]
pub(crate) struct RetainedActiveConnection {
    _lease: Arc<ActiveConnectionLease>,
}

pub(crate) struct ConnectionPermit {
    budget: Arc<HostResourceBudget>,
    phase: PermitPhase,
}

impl ConnectionPermit {
    pub(crate) fn promote(&mut self, class: ConnectionClass) -> Result<(), ConnectionRejection> {
        if !matches!(self.phase, PermitPhase::Pending) {
            return Ok(());
        }
        self.budget.promote(class)?;
        self.phase = PermitPhase::Active(Arc::new(ActiveConnectionLease {
            budget: Arc::clone(&self.budget),
            class,
        }));
        Ok(())
    }

    #[cfg(feature = "terminal-state-stream")]
    pub(crate) fn retain_active(&self) -> Option<RetainedActiveConnection> {
        let PermitPhase::Active(lease) = &self.phase else {
            return None;
        };
        Some(RetainedActiveConnection {
            _lease: Arc::clone(lease),
        })
    }

    pub(crate) fn release(&mut self) {
        match std::mem::replace(&mut self.phase, PermitPhase::Released) {
            PermitPhase::Pending => self.budget.release_pending(),
            PermitPhase::Active(lease) => drop(lease),
            PermitPhase::Released => {}
        }
    }
}

impl Drop for ConnectionPermit {
    fn drop(&mut self) {
        self.release();
    }
}

pub(crate) struct QueueReservation {
    accounted_bytes: usize,
    budget: Arc<HostResourceBudget>,
}

impl QueueReservation {
    #[cfg(feature = "terminal-state-stream")]
    pub(crate) fn try_resize(&mut self, accounted_bytes: usize) -> bool {
        if accounted_bytes == self.accounted_bytes {
            return true;
        }
        let previous_bytes = self.accounted_bytes;
        let resized =
            self.budget
                .queued_bytes
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                    current
                        .checked_sub(previous_bytes)
                        .and_then(|without_previous| without_previous.checked_add(accounted_bytes))
                        .filter(|next| *next <= self.budget.limits.max_queued_bytes)
                });
        let Ok(previous_total) = resized else {
            self.budget
                .rejected_queue_pushes
                .fetch_add(1, Ordering::Relaxed);
            return false;
        };
        self.accounted_bytes = accounted_bytes;
        let current = previous_total - previous_bytes + accounted_bytes;
        self.budget
            .peak_queued_bytes
            .fetch_max(current, Ordering::Relaxed);
        true
    }
}

impl Drop for QueueReservation {
    fn drop(&mut self) {
        self.budget
            .queued_bytes
            .fetch_sub(self.accounted_bytes, Ordering::AcqRel);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn budget(
        pending: usize,
        active: usize,
        reserved: usize,
        queued_bytes: usize,
    ) -> Arc<HostResourceBudget> {
        HostResourceBudget::new(HostResourceLimits {
            max_pending_connections: pending,
            max_active_connections: active,
            reserved_priority_connections: reserved,
            max_queued_bytes: queued_bytes,
        })
    }

    #[test]
    fn pending_admission_is_bounded_across_one_to_one_thousand_attempts() {
        for attempts in [1, 10, 100, 1_000] {
            let budget = budget(16, 64, 8, 1024);
            let mut admitted = Vec::new();
            let mut latencies = Vec::with_capacity(attempts);
            let started = Instant::now();
            for _ in 0..attempts {
                let attempt_started = Instant::now();
                if let Ok(permit) = budget.try_acquire_pending() {
                    admitted.push(permit);
                }
                latencies.push(attempt_started.elapsed());
            }
            latencies.sort_unstable();
            let p95_index = attempts.saturating_mul(95).div_ceil(100).saturating_sub(1);
            let p95 = latencies[p95_index];
            let expected_admitted = attempts.min(16);
            let snapshot = budget.snapshot();
            assert_eq!(snapshot.pending_connections, expected_admitted);
            assert_eq!(snapshot.peak_pending_connections, expected_admitted);
            assert_eq!(
                snapshot.rejected_pending_connections,
                attempts - expected_admitted
            );
            assert!(p95 < Duration::from_millis(50));
            assert!(started.elapsed() < Duration::from_secs(1));
            drop(admitted);
            assert_eq!(budget.snapshot().pending_connections, 0);
        }
    }

    #[test]
    fn connection_worker_count_tracks_exact_lifetime_and_peak() {
        let budget = budget(16, 64, 8, 1024);
        let first = budget.connection_worker_started();
        let second = budget.connection_worker_started();
        assert_eq!(budget.snapshot().connection_workers, 2);
        assert_eq!(budget.snapshot().peak_connection_workers, 2);

        drop(first);
        assert_eq!(budget.snapshot().connection_workers, 1);
        assert_eq!(budget.snapshot().peak_connection_workers, 2);

        drop(second);
        assert_eq!(budget.snapshot().connection_workers, 0);
        assert_eq!(budget.snapshot().peak_connection_workers, 2);
    }

    #[cfg(unix)]
    #[test]
    fn connection_shutdown_waits_for_the_last_owned_worker() {
        let budget = budget(16, 64, 8, 1024);
        let first = budget.connection_worker_started();
        let last = budget.connection_worker_started();
        assert!(!budget.wait_for_connection_workers(Duration::ZERO));
        drop(first);
        assert!(!budget.wait_for_connection_workers(Duration::ZERO));
        let waiting = Arc::clone(&budget);
        let waiter =
            std::thread::spawn(move || waiting.wait_for_connection_workers(Duration::from_secs(3)));
        drop(last);
        assert!(waiter.join().unwrap());
        assert!(budget.wait_for_connection_workers(Duration::ZERO));
    }

    #[cfg(feature = "terminal-state-stream")]
    #[test]
    fn detached_parked_projection_workers_stay_inside_the_active_ceiling() {
        let budget = budget(4, 2, 0, 1024);
        let parked = Arc::new((Mutex::new((0_usize, false)), std::sync::Condvar::new()));
        let mut permits = Vec::new();
        let mut workers = Vec::new();
        for _ in 0..2 {
            let mut permit = budget.try_acquire_pending().unwrap();
            permit.promote(ConnectionClass::Ordinary).unwrap();
            let active_connection = permit.retain_active().unwrap();
            permits.push(permit);
            let parked = Arc::clone(&parked);
            workers.push(std::thread::spawn(move || {
                let _active_connection = active_connection;
                let (state, changed) = &*parked;
                let mut state = state.lock().unwrap();
                state.0 += 1;
                changed.notify_all();
                while !state.1 {
                    state = changed.wait(state).unwrap();
                }
            }));
        }
        {
            let (state, changed) = &*parked;
            let state = state.lock().unwrap();
            let _state = changed.wait_while(state, |state| state.0 < 2).unwrap();
        }

        drop(permits);
        let mut replacement = budget.try_acquire_pending().unwrap();
        assert_eq!(
            replacement.promote(ConnectionClass::Ordinary),
            Err(ConnectionRejection::ActiveLimit)
        );

        {
            let (state, changed) = &*parked;
            let mut state = state.lock().unwrap();
            state.1 = true;
            changed.notify_all();
        }
        for worker in workers {
            worker.join().unwrap();
        }
        replacement.promote(ConnectionClass::Ordinary).unwrap();
        assert_eq!(budget.snapshot().active_connections, 1);
        replacement.release();
        assert_eq!(budget.snapshot().active_connections, 0);
    }

    #[test]
    fn ordinary_connections_cannot_consume_controller_and_termination_reserve() {
        let budget = budget(16, 8, 2, 1024);
        let mut ordinary = (0..6)
            .map(|_| {
                let mut permit = budget.try_acquire_pending().unwrap();
                permit.promote(ConnectionClass::Ordinary).unwrap();
                permit
            })
            .collect::<Vec<_>>();
        let mut refused = budget.try_acquire_pending().unwrap();
        assert_eq!(
            refused.promote(ConnectionClass::Ordinary),
            Err(ConnectionRejection::ActiveLimit)
        );
        drop(refused);

        let mut priority = (0..2)
            .map(|_| {
                let mut permit = budget.try_acquire_pending().unwrap();
                permit.promote(ConnectionClass::Priority).unwrap();
                permit
            })
            .collect::<Vec<_>>();
        let mut exhausted = budget.try_acquire_pending().unwrap();
        assert_eq!(
            exhausted.promote(ConnectionClass::Priority),
            Err(ConnectionRejection::ActiveLimit)
        );
        drop(exhausted);

        let snapshot = budget.snapshot();
        assert_eq!(snapshot.active_connections, 8);
        assert_eq!(snapshot.peak_active_connections, 8);
        assert_eq!(snapshot.rejected_active_connections, 2);
        ordinary.clear();
        priority.clear();
        assert_eq!(budget.snapshot().active_connections, 0);
    }

    #[test]
    fn priority_connections_do_not_reduce_the_ordinary_share_twice() {
        let budget = budget(64, 64, 8, 1024);
        let mut priority = (0..8)
            .map(|_| {
                let mut permit = budget.try_acquire_pending().unwrap();
                permit.promote(ConnectionClass::Priority).unwrap();
                permit
            })
            .collect::<Vec<_>>();
        let mut ordinary = (0..56)
            .map(|_| {
                let mut permit = budget.try_acquire_pending().unwrap();
                permit.promote(ConnectionClass::Ordinary).unwrap();
                permit
            })
            .collect::<Vec<_>>();

        assert_eq!(budget.snapshot().active_connections, 64);
        ordinary.clear();
        priority.clear();
        assert_eq!(budget.snapshot().active_connections, 0);
    }

    #[test]
    fn aggregate_queue_reservations_release_exactly_once() {
        let budget = budget(1, 2, 1, 10);
        let first = budget.try_reserve_queue_bytes(6).unwrap();
        assert!(budget.try_reserve_queue_bytes(5).is_none());
        assert_eq!(
            budget.snapshot(),
            HostResourceSnapshot {
                queued_bytes: 6,
                peak_queued_bytes: 6,
                rejected_queue_pushes: 1,
                ..HostResourceSnapshot::default()
            }
        );
        drop(first);
        let second = budget.try_reserve_queue_bytes(10).unwrap();
        assert_eq!(budget.snapshot().queued_bytes, 10);
        assert_eq!(budget.snapshot().peak_queued_bytes, 10);
        drop(second);
        assert_eq!(budget.snapshot().queued_bytes, 0);
    }
}
