use std::io;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, LockResult, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

#[derive(Default)]
pub(crate) struct RetirementSchedule {
    generation: u64,
    armed_generation: Option<u64>,
    deadline: Option<Instant>,
    retry_attempts: u32,
    shutdown: bool,
}

impl RetirementSchedule {
    #[must_use]
    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }

    #[must_use]
    pub(crate) fn is_armed(&self, generation: u64) -> bool {
        self.armed_generation == Some(generation)
    }

    pub(crate) fn cancel_and_advance(&mut self) {
        self.generation = self.generation.saturating_add(1);
        self.armed_generation = None;
        self.deadline = None;
        self.retry_attempts = 0;
    }

    pub(crate) fn arm_after(&mut self, delay: Duration) -> u64 {
        self.generation = self.generation.saturating_add(1);
        let generation = self.generation;
        self.armed_generation = Some(generation);
        self.deadline = Some(Instant::now() + delay);
        self.retry_attempts = 0;
        generation
    }

    pub(crate) fn retry_after_if_armed(
        &mut self,
        generation: u64,
        base_delay: Duration,
        max_retries: u32,
    ) -> bool {
        if self.armed_generation != Some(generation) || self.retry_attempts >= max_retries {
            return false;
        }
        let multiplier = 1_u32
            .checked_shl(self.retry_attempts.min(31))
            .unwrap_or(u32::MAX);
        self.retry_attempts = self.retry_attempts.saturating_add(1);
        self.deadline = Some(Instant::now() + base_delay.saturating_mul(multiplier));
        true
    }

    pub(crate) fn clear_if_armed(&mut self, generation: u64) {
        if self.armed_generation == Some(generation) {
            self.armed_generation = None;
            self.deadline = None;
            self.retry_attempts = 0;
        }
    }
}

struct RetirementTimerCore {
    schedule: Mutex<RetirementSchedule>,
    wake: Condvar,
}

pub(crate) struct RetirementTimer {
    core: Arc<RetirementTimerCore>,
    worker: Mutex<Option<JoinHandle<()>>>,
    worker_starts: AtomicU64,
}

impl Default for RetirementTimer {
    fn default() -> Self {
        Self {
            core: Arc::new(RetirementTimerCore {
                schedule: Mutex::new(RetirementSchedule::default()),
                wake: Condvar::new(),
            }),
            worker: Mutex::new(None),
            worker_starts: AtomicU64::new(0),
        }
    }
}

impl RetirementTimer {
    pub(crate) fn start<F>(&self, callback: F) -> io::Result<()>
    where
        F: Fn(u64) + Send + 'static,
    {
        let mut worker = self
            .worker
            .lock()
            .map_err(|_| io::Error::other("retirement timer worker lock is poisoned"))?;
        if worker.is_some() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "retirement timer worker is already running",
            ));
        }
        let core = Arc::clone(&self.core);
        let handle = thread::Builder::new()
            .name("hmux-retirement-timer".to_string())
            .spawn(move || run_timer_worker(&core, callback))?;
        self.worker_starts.fetch_add(1, Ordering::Release);
        *worker = Some(handle);
        Ok(())
    }

    pub(crate) fn lock_schedule(&self) -> LockResult<MutexGuard<'_, RetirementSchedule>> {
        self.core.schedule.lock()
    }

    pub(crate) fn notify_changed(&self) {
        self.core.wake.notify_all();
    }

    pub(crate) fn shutdown(&self) -> io::Result<()> {
        {
            let mut schedule = self
                .core
                .schedule
                .lock()
                .map_err(|_| io::Error::other("retirement timer schedule lock is poisoned"))?;
            schedule.shutdown = true;
            schedule.armed_generation = None;
            schedule.deadline = None;
            schedule.retry_attempts = 0;
        }
        self.core.wake.notify_all();
        let handle = self
            .worker
            .lock()
            .map_err(|_| io::Error::other("retirement timer worker lock is poisoned"))?
            .take();
        if let Some(handle) = handle {
            handle
                .join()
                .map_err(|_| io::Error::other("retirement timer worker panicked"))?;
        }
        Ok(())
    }

    #[cfg(test)]
    fn worker_start_count(&self) -> u64 {
        self.worker_starts.load(Ordering::Acquire)
    }
}

fn run_timer_worker<F>(core: &RetirementTimerCore, callback: F)
where
    F: Fn(u64),
{
    let Ok(mut schedule) = core.schedule.lock() else {
        return;
    };
    loop {
        if schedule.shutdown {
            return;
        }
        let Some((generation, deadline)) = schedule.armed_generation.zip(schedule.deadline) else {
            let Ok(next) = core.wake.wait(schedule) else {
                return;
            };
            schedule = next;
            continue;
        };
        let now = Instant::now();
        if now < deadline {
            let Ok((next, _)) = core.wake.wait_timeout(schedule, deadline - now) else {
                return;
            };
            schedule = next;
            continue;
        }

        // Consume this deadline before invoking Host code. The callback still
        // validates `armed_generation` under the Host transition gates, but a
        // poisoned Host lock must not make this worker spin on a past deadline.
        if schedule.armed_generation == Some(generation) && schedule.deadline == Some(deadline) {
            schedule.deadline = None;
        }
        drop(schedule);
        callback(generation);
        let Ok(next) = core.schedule.lock() else {
            return;
        };
        schedule = next;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn repeated_max_grace_arm_and_cancel_uses_one_worker() {
        let timer = RetirementTimer::default();
        let (fired_tx, fired_rx) = mpsc::channel();
        timer
            .start(move |generation| {
                let _ = fired_tx.send(generation);
            })
            .unwrap();

        for _ in 0..10_000 {
            let mut schedule = timer.lock_schedule().unwrap();
            schedule.arm_after(Duration::from_secs(300));
            schedule.cancel_and_advance();
            drop(schedule);
            timer.notify_changed();
        }

        assert_eq!(timer.worker_start_count(), 1);
        assert!(matches!(
            timer.start(|_| {}),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists
        ));
        assert!(fired_rx.try_recv().is_err());

        let expected = {
            let mut schedule = timer.lock_schedule().unwrap();
            schedule.arm_after(Duration::from_millis(1))
        };
        timer.notify_changed();
        assert_eq!(
            fired_rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            expected
        );
        timer.shutdown().unwrap();
        assert_eq!(timer.worker_start_count(), 1);
    }

    #[test]
    fn transient_retries_keep_one_generation_and_cancel_atomically() {
        let mut schedule = RetirementSchedule::default();
        let generation = schedule.arm_after(Duration::from_secs(30));

        for expected_attempts in 1..=3 {
            assert!(schedule.retry_after_if_armed(generation, Duration::from_millis(10), 3,));
            assert!(schedule.is_armed(generation));
            assert_eq!(schedule.retry_attempts, expected_attempts);
            assert!(schedule.deadline.is_some());
        }
        assert!(!schedule.retry_after_if_armed(generation, Duration::from_millis(10), 3,));

        schedule.cancel_and_advance();
        assert!(!schedule.is_armed(generation));
        assert!(!schedule.retry_after_if_armed(generation, Duration::from_millis(10), 3,));
        assert_eq!(schedule.retry_attempts, 0);
    }
}
