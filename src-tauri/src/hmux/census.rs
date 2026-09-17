use std::panic::{AssertUnwindSafe, catch_unwind, resume_unwind};
use std::path::PathBuf;
use std::sync::{
    Condvar, Mutex,
    atomic::{AtomicUsize, Ordering},
};
use std::thread;
use std::time::{Duration, Instant};

use hmux_client::{LocalSessionCatalog, SessionDescriptor, SessionLifecycle};

use super::{
    HmuxManager, ProbeHealth, SessionSummary, probe_and_project_session_until,
    project_known_healthy_session, project_session_with_health,
};

/// Shares only an operation that was already running when a caller arrived.
/// There is intentionally no freshness window: a later authority-sensitive
/// census still reads current discovery state instead of reusing stale data.
pub(super) struct OverlappingCallCoalescer<T> {
    state: Mutex<OverlappingCallState<T>>,
    state_changed: Condvar,
    #[cfg(test)]
    follower_registered: Condvar,
}

enum OverlappingCallState<T> {
    Idle,
    Running {
        followers: usize,
    },
    Completed {
        result: Result<T, String>,
        remaining_followers: usize,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CallRegistration {
    Leader,
    Follower,
    WaitForFresh,
}

impl<T> OverlappingCallState<T> {
    fn register_call(&mut self) -> CallRegistration {
        match self {
            Self::Idle => {
                *self = Self::Running { followers: 0 };
                CallRegistration::Leader
            }
            Self::Running { followers } => {
                *followers += 1;
                CallRegistration::Follower
            }
            Self::Completed { .. } => CallRegistration::WaitForFresh,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct CoalescedCall<T> {
    pub(super) value: T,
    pub(super) joined_existing: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct CensusPhaseDurations {
    pub(super) catalog_us: u64,
    pub(super) health_projection_us: u64,
    pub(super) total_us: u64,
}

fn duration_us(duration: Duration) -> u64 {
    u64::try_from(duration.as_micros()).unwrap_or(u64::MAX)
}

pub(super) fn census_phase_durations(
    started: Instant,
    catalog_completed: Instant,
    health_projection_started: Instant,
    completed: Instant,
) -> CensusPhaseDurations {
    CensusPhaseDurations {
        catalog_us: duration_us(catalog_completed.saturating_duration_since(started)),
        health_projection_us: duration_us(
            completed.saturating_duration_since(health_projection_started),
        ),
        total_us: duration_us(completed.saturating_duration_since(started)),
    }
}

impl<T> Default for OverlappingCallCoalescer<T> {
    fn default() -> Self {
        Self {
            state: Mutex::new(OverlappingCallState::Idle),
            state_changed: Condvar::new(),
            #[cfg(test)]
            follower_registered: Condvar::new(),
        }
    }
}

impl<T: Clone> OverlappingCallCoalescer<T> {
    fn complete(&self, result: &Result<T, String>) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Hmux census coalescer poisoned".to_string())?;
        let followers = match &*state {
            OverlappingCallState::Running { followers } => *followers,
            _ => return Err("Hmux census completed without a result".to_string()),
        };
        *state = if followers == 0 {
            OverlappingCallState::Idle
        } else {
            OverlappingCallState::Completed {
                result: result.clone(),
                remaining_followers: followers,
            }
        };
        self.state_changed.notify_all();
        Ok(())
    }

    pub(super) fn run<F>(&self, operation: F) -> Result<CoalescedCall<T>, String>
    where
        F: FnOnce() -> Result<T, String>,
    {
        let mut operation = Some(operation);
        loop {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "Hmux census coalescer poisoned".to_string())?;
            match state.register_call() {
                CallRegistration::Leader => {
                    drop(state);
                    let outcome = catch_unwind(AssertUnwindSafe(
                        operation
                            .take()
                            .expect("idle census caller should own its operation"),
                    ));
                    let result = match outcome {
                        Ok(result) => result,
                        Err(payload) => {
                            let failure =
                                Err("Hmux census coalescer operation panicked".to_string());
                            let _ = self.complete(&failure);
                            resume_unwind(payload);
                        }
                    };
                    self.complete(&result)?;
                    return result.map(|value| CoalescedCall {
                        value,
                        joined_existing: false,
                    });
                }
                CallRegistration::Follower => {
                    #[cfg(test)]
                    self.follower_registered.notify_all();
                    loop {
                        state = self
                            .state_changed
                            .wait(state)
                            .map_err(|_| "Hmux census coalescer poisoned".to_string())?;
                        let (result, final_follower) = match &mut *state {
                            OverlappingCallState::Running { .. } => continue,
                            OverlappingCallState::Completed {
                                result,
                                remaining_followers,
                            } => {
                                let result = result.clone();
                                *remaining_followers -= 1;
                                (result, *remaining_followers == 0)
                            }
                            OverlappingCallState::Idle => {
                                return Err(
                                    "Hmux census completed without a result".to_string(),
                                );
                            }
                        };
                        if final_follower {
                            *state = OverlappingCallState::Idle;
                            self.state_changed.notify_all();
                        }
                        return result.map(|value| CoalescedCall {
                            value,
                            joined_existing: true,
                        });
                    }
                }
                CallRegistration::WaitForFresh => {
                    drop(
                        self.state_changed
                            .wait(state)
                            .map_err(|_| "Hmux census coalescer poisoned".to_string())?,
                    );
                }
            }
        }
    }

    #[cfg(test)]
    fn wait_for_registered_followers(&self, expected: usize) {
        let state = self.state.lock().expect("census coalescer poisoned");
        let (state, timeout) = self
            .follower_registered
            .wait_timeout_while(state, Duration::from_secs(5), |state| {
                !matches!(
                    state,
                    OverlappingCallState::Running { followers }
                        if *followers == expected
                )
            })
            .expect("census coalescer poisoned");
        assert!(!timeout.timed_out(), "followers did not register");
        assert!(matches!(
            &*state,
            OverlappingCallState::Running { followers } if *followers == expected
        ));
    }
}

pub(super) fn map_bounded_with_budget<T, R, F, P, G>(
    items: Vec<T>,
    maximum_workers: usize,
    total_budget: Duration,
    probe_quantum: Duration,
    should_probe: P,
    probe: F,
    fallback: G,
) -> Vec<R>
where
    T: Sync,
    R: Send,
    F: Fn(&T, Instant) -> R + Sync,
    P: Fn(&T) -> bool + Sync,
    G: Fn(T) -> R,
{
    if items.is_empty() {
        return Vec::new();
    }
    let worker_count = maximum_workers.clamp(1, 8).min(items.len());
    let deadline = Instant::now() + total_budget;
    let next = AtomicUsize::new(0);
    let results = Mutex::new(
        std::iter::repeat_with(|| None)
            .take(items.len())
            .collect::<Vec<Option<R>>>(),
    );
    thread::scope(|scope| {
        for _ in 0..worker_count {
            let items = &items;
            let next = &next;
            let results = &results;
            let should_probe = &should_probe;
            let probe = &probe;
            scope.spawn(move || {
                loop {
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    let Some(item) = items.get(index) else {
                        break;
                    };
                    if !should_probe(item) {
                        continue;
                    }
                    let Some(probe_deadline) = Instant::now().checked_add(probe_quantum) else {
                        break;
                    };
                    if probe_deadline > deadline {
                        break;
                    }
                    results.lock().expect("census results poisoned")[index] =
                        Some(probe(item, probe_deadline));
                }
            });
        }
    });
    let mut results = results.into_inner().expect("census results poisoned");
    items
        .into_iter()
        .enumerate()
        .map(|(index, item)| results[index].take().unwrap_or_else(|| fallback(item)))
        .collect()
}

pub(super) fn project_sessions_with_structured_health(
    manager: &HmuxManager,
    sessions: Vec<SessionDescriptor>,
    discovery_root: PathBuf,
    total_budget: Duration,
    maximum_workers: usize,
    probe_quantum: Duration,
) -> Vec<SessionSummary> {
    let probing_manager = manager;
    let fallback_manager = manager;
    map_bounded_with_budget(
        sessions,
        maximum_workers,
        total_budget,
        probe_quantum,
        |session| session.lifecycle == SessionLifecycle::Ready,
        move |session, deadline| {
            if probing_manager.has_live_structured_terminal_generation(session) {
                return project_known_healthy_session(session.clone());
            }
            let catalog = LocalSessionCatalog::new(discovery_root.clone());
            probe_and_project_session_until(&catalog, session.clone(), Some(deadline))
        },
        |session| {
            if fallback_manager.has_live_structured_terminal_generation(&session) {
                return project_known_healthy_session(session);
            }
            let health = match session.lifecycle {
                SessionLifecycle::Ready => ProbeHealth::Unprobed,
                SessionLifecycle::Exited => ProbeHealth::Exited,
            };
            project_session_with_health(session, health)
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier, atomic::AtomicUsize};

    #[test]
    fn completed_result_is_reserved_for_registered_followers() {
        let mut state = OverlappingCallState::Completed {
            result: Ok(1),
            remaining_followers: 1,
        };

        assert_eq!(state.register_call(), CallRegistration::WaitForFresh);
        assert!(matches!(
            state,
            OverlappingCallState::Completed {
                result: Ok(1),
                remaining_followers: 1,
            }
        ));
    }

    #[test]
    fn panicked_operation_retains_failure_until_registered_followers_drain() {
        let coalescer = OverlappingCallCoalescer::<usize>::default();
        *coalescer.state.lock().unwrap() = OverlappingCallState::Running { followers: 2 };

        coalescer
            .complete(&Err("operation panicked".to_string()))
            .expect("terminal failure should be retained");

        let state = coalescer.state.lock().unwrap();
        assert!(matches!(
            &*state,
            OverlappingCallState::Completed {
                result: Err(error),
                remaining_followers: 2,
            } if error == "operation panicked"
        ));
    }

    #[test]
    fn overlapping_calls_share_one_result_but_sequential_calls_stay_fresh() {
        #[derive(Clone, Debug, Eq, PartialEq)]
        struct SharedExecution {
            marker: usize,
            phases: CensusPhaseDurations,
        }

        let coalescer = Arc::new(OverlappingCallCoalescer::<SharedExecution>::default());
        let calls = Arc::new(AtomicUsize::new(0));
        let operation_started = Arc::new(Barrier::new(2));
        let release_operation = Arc::new(Barrier::new(2));
        let leader = {
            let coalescer = Arc::clone(&coalescer);
            let calls = Arc::clone(&calls);
            let operation_started = Arc::clone(&operation_started);
            let release_operation = Arc::clone(&release_operation);
            thread::spawn(move || {
                coalescer.run(|| {
                    let call = calls.fetch_add(1, Ordering::SeqCst) + 1;
                    operation_started.wait();
                    release_operation.wait();
                    Ok(SharedExecution {
                        marker: call,
                        phases: CensusPhaseDurations {
                            catalog_us: 7,
                            health_projection_us: 18,
                            total_us: 29,
                        },
                    })
                })
            })
        };
        operation_started.wait();
        let followers = (0..7)
            .map(|_| {
                let coalescer = Arc::clone(&coalescer);
                thread::spawn(move || {
                    coalescer.run(|| {
                        panic!("registered follower must not execute its operation")
                    })
                })
            })
            .collect::<Vec<_>>();
        coalescer.wait_for_registered_followers(7);
        release_operation.wait();

        let leader = leader
            .join()
            .expect("leader should not panic")
            .expect("leader should succeed");
        let results = followers
            .into_iter()
            .map(|worker| worker.join().expect("worker should not panic"))
            .collect::<Result<Vec<_>, _>>()
            .expect("burst should succeed");

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(leader.value.marker, 1);
        assert!(!leader.joined_existing);
        assert!(results.iter().all(|result| {
            result.value
                == SharedExecution {
                    marker: 1,
                    phases: CensusPhaseDurations {
                        catalog_us: 7,
                        health_projection_us: 18,
                        total_us: 29,
                    },
                }
        }));
        assert!(results.iter().all(|result| result.joined_existing));
        let later = coalescer
            .run(|| {
                Ok(SharedExecution {
                    marker: calls.fetch_add(1, Ordering::SeqCst) + 1,
                    phases: CensusPhaseDurations {
                        catalog_us: 8,
                        health_projection_us: 19,
                        total_us: 31,
                    },
                })
            })
            .expect("later census should succeed");
        assert_eq!(later.value.marker, 2);
        assert!(!later.joined_existing);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn census_phase_durations_share_one_execution_timeline() {
        let started = Instant::now();
        let phases = census_phase_durations(
            started,
            started + Duration::from_micros(7),
            started + Duration::from_micros(11),
            started + Duration::from_micros(29),
        );

        assert_eq!(
            phases,
            CensusPhaseDurations {
                catalog_us: 7,
                health_projection_us: 18,
                total_us: 29,
            }
        );
    }

    #[test]
    fn silent_catalog_stops_at_the_global_budget_and_worker_bound() {
        let active = AtomicUsize::new(0);
        let maximum_active = AtomicUsize::new(0);
        let started = Instant::now();
        let results = map_bounded_with_budget(
            (0..128).collect::<Vec<_>>(),
            4,
            Duration::from_millis(50),
            Duration::from_millis(20),
            |_| true,
            |_item, deadline| {
                let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                maximum_active.fetch_max(current, Ordering::SeqCst);
                thread::sleep(deadline.saturating_duration_since(Instant::now()));
                active.fetch_sub(1, Ordering::SeqCst);
                true
            },
            |_| false,
        );

        let probed = results.iter().filter(|result| **result).count();
        assert!(started.elapsed() < Duration::from_millis(150));
        assert!((1..=8).contains(&probed), "{probed}");
        assert!(maximum_active.load(Ordering::SeqCst) <= 4);
        assert!(results.iter().skip(probed).all(|result| !result));
    }

    #[test]
    fn zero_budget_uses_the_unprobed_projection_without_starting_work() {
        let results = map_bounded_with_budget(
            (0..3).collect::<Vec<_>>(),
            4,
            Duration::ZERO,
            Duration::from_millis(20),
            |_| true,
            |_item, _deadline| panic!("zero budget must not start a probe"),
            |item| format!("unprobed-{item}"),
        );

        assert_eq!(
            results,
            vec!["unprobed-0", "unprobed-1", "unprobed-2"]
        );
    }
}
