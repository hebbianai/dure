//! Reports on their way to the Host, applied in order per session after the
//! reporter has been answered. The managed Claude hook endpoint answers once
//! its report is queued here: Host admission runs the private broker once per
//! managed report, which can take seconds on a loaded machine, and waiting
//! for it spent most of the hook's 2.4 s budget (#822).

use std::{
    collections::{HashMap, VecDeque},
    hash::Hash,
    panic::AssertUnwindSafe,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
};

/// Reports one session may hold while its Host is slow. A session with this
/// many waiting has a Host that stopped answering: later reports are refused
/// rather than held without bound.
const MAX_WAITING_PER_SESSION: usize = 64;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum QueueRefusal {
    /// The session already holds the most reports it may wait with.
    Backlogged,
    /// No worker could be started for the session.
    Unavailable,
}

impl QueueRefusal {
    pub(super) fn code(self) -> &'static str {
        match self {
            Self::Backlogged => "report_backlogged",
            Self::Unavailable => "report_queue_unavailable",
        }
    }
}

/// Applies each session's reports one at a time, in the order they were
/// queued. A provider runs one session's hooks one after another and each
/// waits for its answer, so queue order is the session's source order: a
/// `SessionStart` that announces a successor still reaches the Host before
/// the prompt that relies on it. Sessions never wait for each other.
pub(super) struct OrderedReports<K, T> {
    waiting: Mutex<HashMap<K, VecDeque<T>>>,
    session: fn(&T) -> K,
    apply: Box<dyn Fn(T) + Send + Sync>,
}

impl<K, T> OrderedReports<K, T>
where
    K: Clone + Eq + Hash + Send + 'static,
    T: Send + 'static,
{
    /// `session` names the Host session a report belongs to; `apply` delivers
    /// one report, with every outcome its own to record.
    pub(super) fn new(
        session: fn(&T) -> K,
        apply: impl Fn(T) + Send + Sync + 'static,
    ) -> Arc<Self> {
        Arc::new(Self {
            waiting: Mutex::new(HashMap::new()),
            session,
            apply: Box::new(apply),
        })
    }

    /// Queues `report` behind its session's earlier reports. A session has a
    /// worker exactly while it has an entry; the first report of an idle
    /// session starts one, and it ends once the queue is empty.
    pub(super) fn push(self: &Arc<Self>, report: T) -> Result<(), QueueRefusal> {
        let session = (self.session)(&report);
        let mut waiting = self.waiting();
        if let Some(queue) = waiting.get_mut(&session) {
            if queue.len() >= MAX_WAITING_PER_SESSION {
                return Err(QueueRefusal::Backlogged);
            }
            queue.push_back(report);
            return Ok(());
        }
        waiting.insert(session.clone(), VecDeque::from([report]));
        // Started under the lock, so no later report joins a queue whose
        // worker failed to start.
        let reports = Arc::clone(self);
        let worker_session = session.clone();
        let started = std::thread::Builder::new()
            .name("dure-ordered-reports".into())
            .spawn(move || reports.drain(&worker_session));
        if started.is_err() {
            waiting.remove(&session);
            return Err(QueueRefusal::Unavailable);
        }
        Ok(())
    }

    fn drain(&self, session: &K) {
        loop {
            let report = {
                let mut waiting = self.waiting();
                match waiting.get_mut(session).and_then(VecDeque::pop_front) {
                    Some(report) => report,
                    None => {
                        waiting.remove(session);
                        return;
                    }
                }
            };
            // A report that panics must not leave its session without a worker.
            if std::panic::catch_unwind(AssertUnwindSafe(|| (self.apply)(report))).is_err() {
                eprintln!("a queued report panicked on its way to the Host");
            }
        }
    }

    fn waiting(&self) -> MutexGuard<'_, HashMap<K, VecDeque<T>>> {
        // Nothing panics while holding the lock; a poisoned map is still whole.
        self.waiting.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{mpsc, Condvar};
    use std::time::Duration;

    /// A report names its session and its place in that session's order.
    type Report = (&'static str, u32);
    type Reports = Arc<OrderedReports<&'static str, Report>>;

    /// A Host stand-in that holds every report of the "slow" session until
    /// the test opens it.
    #[derive(Default)]
    struct Gate {
        open: Mutex<bool>,
        changed: Condvar,
    }

    impl Gate {
        fn wait(&self) {
            let open = self.open.lock().unwrap();
            drop(self.changed.wait_while(open, |open| !*open).unwrap());
        }

        fn open(&self) {
            *self.open.lock().unwrap() = true;
            self.changed.notify_all();
        }
    }

    fn gated(gate: &Arc<Gate>) -> (Reports, mpsc::Receiver<Report>) {
        let (sender, applied) = mpsc::channel();
        let sender = Mutex::new(sender);
        let gate = Arc::clone(gate);
        let reports = OrderedReports::new(
            |report: &Report| report.0,
            move |report: Report| {
                if report.0 == "slow" {
                    gate.wait();
                }
                sender.lock().unwrap().send(report).unwrap();
            },
        );
        (reports, applied)
    }

    fn next(applied: &mpsc::Receiver<Report>) -> Report {
        applied.recv_timeout(Duration::from_secs(5)).unwrap()
    }

    #[test]
    fn a_report_is_queued_without_waiting_for_the_host_and_applied_later() {
        let gate = Arc::new(Gate::default());
        let (reports, applied) = gated(&gate);
        reports.push(("slow", 1)).unwrap();
        assert!(applied.recv_timeout(Duration::from_millis(100)).is_err());
        gate.open();
        assert_eq!(next(&applied), ("slow", 1));
    }

    #[test]
    fn one_sessions_reports_reach_the_host_in_arrival_order() {
        let gate = Arc::new(Gate::default());
        let (reports, applied) = gated(&gate);
        for sequence in 1..=5 {
            reports.push(("slow", sequence)).unwrap();
        }
        gate.open();
        let order: Vec<_> = (0..5).map(|_| next(&applied).1).collect();
        assert_eq!(order, [1, 2, 3, 4, 5]);
    }

    #[test]
    fn a_slow_session_never_holds_another_sessions_report() {
        let gate = Arc::new(Gate::default());
        let (reports, applied) = gated(&gate);
        reports.push(("slow", 1)).unwrap();
        reports.push(("other", 1)).unwrap();
        assert_eq!(next(&applied), ("other", 1));
        gate.open();
        assert_eq!(next(&applied), ("slow", 1));
    }

    #[test]
    fn a_session_whose_host_stopped_answering_refuses_reports_past_its_bound() {
        let gate = Arc::new(Gate::default());
        let (reports, applied) = gated(&gate);
        // One report is with the Host; the bound counts the ones behind it.
        reports.push(("slow", 0)).unwrap();
        while !reports.waiting()["slow"].is_empty() {
            std::thread::yield_now();
        }
        for sequence in 1..=MAX_WAITING_PER_SESSION as u32 {
            reports.push(("slow", sequence)).unwrap();
        }
        assert_eq!(
            reports.push(("slow", u32::MAX)),
            Err(QueueRefusal::Backlogged)
        );
        assert_eq!(reports.push(("other", 1)), Ok(()));
        assert_eq!(next(&applied), ("other", 1));
        gate.open();
        for sequence in 0..=MAX_WAITING_PER_SESSION as u32 {
            assert_eq!(next(&applied), ("slow", sequence));
        }
    }

    #[test]
    fn a_drained_session_starts_a_new_worker_for_its_next_report() {
        let gate = Arc::new(Gate::default());
        gate.open();
        let (reports, applied) = gated(&gate);
        reports.push(("slow", 1)).unwrap();
        assert_eq!(next(&applied), ("slow", 1));
        while reports.waiting().contains_key("slow") {
            std::thread::yield_now();
        }
        reports.push(("slow", 2)).unwrap();
        assert_eq!(next(&applied), ("slow", 2));
    }

    #[test]
    fn a_report_that_panics_does_not_stall_its_session() {
        let (sender, applied) = mpsc::channel();
        let sender = Mutex::new(sender);
        let reports = OrderedReports::new(
            |_: &u32| "session",
            move |report: u32| {
                if report == 1 {
                    panic!("fixture Host failure");
                }
                sender.lock().unwrap().send(report).unwrap();
            },
        );
        reports.push(1).unwrap();
        reports.push(2).unwrap();
        assert_eq!(applied.recv_timeout(Duration::from_secs(5)).unwrap(), 2);
    }
}
